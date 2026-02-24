package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ==================== 配置 ====================
type Config struct {
	AdminPassword     string        `json:"adminPassword"`
	AdminPasswordHash string        `json:"adminPasswordHash,omitempty"`
	Features          Features      `json:"features"`
	StorageConfig     StorageConfig `json:"storageConfig"`
	Security          Security      `json:"security"`
	Stats             AdminStats    `json:"stats"`
	Theme             string        `json:"theme"`
}

type Features struct {
	MemoryStreaming bool `json:"memoryStreaming"`
	ServerStorage   bool `json:"serverStorage"`
	P2PDirect       bool `json:"p2pDirect"`
}

type StorageConfig struct {
	UploadDir          string `json:"uploadDir"`
	MaxStorageSize     int64  `json:"maxStorageSize"`
	FileRetentionHours int    `json:"fileRetentionHours"`
	DeleteOnDownload   bool   `json:"deleteOnDownload"`
	NeverDelete        bool   `json:"neverDelete"`
}

type Security struct {
	MaxCodeAttempts  int `json:"maxCodeAttempts"`
	SessionTimeout   int `json:"sessionTimeout"`
	AdminTokenExpiry int `json:"adminTokenExpiry"`
}

type AdminStats struct {
	TotalTransfers int64  `json:"totalTransfers"`
	TodayTransfers int64  `json:"todayTransfers"`
	TodayDate      string `json:"todayDate,omitempty"`
}

type StorageIndex struct {
	Files map[string]*FileSession `json:"files"`
}

var config Config

// ==================== 运行时状态 ====================
type FileSession struct {
	PickupCode       string
	FileName         string
	OriginalName     string
	Size             int64
	FileHash         string
	UploadTime       time.Time
	DeleteTime       time.Time
	DeleteMode       string // "timer", "download", "never"
	Downloaded       bool
	ReceiverSocketID string
}

type ActiveSession struct {
	SocketID            string
	PickupCode          string
	Mode                string
	FileName            string
	Size                int64
	Transferred         int64
	CreatedAt           time.Time
	LastActiveAt        time.Time
	IsSender            bool
	ReceiverSocketID    string
	ExpectedFileHash    string
	PendingChunkMeta    map[int]map[string]interface{}
	PendingTransferEnd  bool
	TransferEndPayload  map[string]interface{}
	// HTTP 流下载相关
	DownloadResponse    http.ResponseWriter
	DownloadFlusher    http.Flusher
	// P2P NAT 信息
	SenderNAT           map[string]interface{}
	ReceiverNAT         map[string]interface{}
}

type AdminToken struct {
	Token     string
	ExpiresAt time.Time
}

type NATInfo struct {
	Type            string `json:"type"`
	RemoteCandidate string `json:"remoteCandidate,omitempty"`
}

// 全局状态
var (
	activeSessions   = make(map[string]*ActiveSession)
	activeSessionsMu sync.RWMutex

	storedFiles   = make(map[string]*FileSession)
	storedFilesMu sync.RWMutex

	adminTokens   = make(map[string]*AdminToken)
	adminTokensMu sync.RWMutex

	wsClients   = make(map[string]*WSClient)
	wsClientsMu sync.RWMutex

	codeAttempts   = make(map[string]int)
	codeAttemptsMu sync.RWMutex

	fileTransferChannels = make(map[string]chan []byte)
	transferChanMu       sync.RWMutex
	statsMu              sync.Mutex

	configPath      = "./config.json"
	storageIndexPath = "./storage_index.json"
	uploadDir       = "./files"

	maxFileSize int64 = 5 * 1024 * 1024 * 1024 // 5GB
)

const letterBytes = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

// ==================== WebSocket 设置 ====================
var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// ==================== 初始化 ====================
func init() {
	// 加载配置
	loadConfig()
	loadStorageIndex()

	// 确保上传目录存在
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Printf("[警告] 无法创建上传目录: %v", err)
	}

	refreshLegacyFileHashesAndPersist()

	// 定期清理过期会话和文件
	go cleanupRoutine()
}

func loadConfig() {
	data, err := os.ReadFile(configPath)
	if err != nil {
		log.Printf("[配置] 使用默认配置: %v", err)
		config = getDefaultConfig()
		return
	}

	if err := json.Unmarshal(data, &config); err != nil {
		log.Printf("[配置] 解析失败，使用默认: %v", err)
		config = getDefaultConfig()
		return
	}

	// 设置默认值
	if config.Security.MaxCodeAttempts == 0 {
		config.Security.MaxCodeAttempts = 10
	}
	if config.Security.SessionTimeout == 0 {
		config.Security.SessionTimeout = 1800000
	}
	if config.Security.AdminTokenExpiry == 0 {
		config.Security.AdminTokenExpiry = 3600000
	}
	if config.Stats.TodayDate == "" {
		config.Stats.TodayDate = time.Now().Format("2006-01-02")
	}

	uploadDir = config.StorageConfig.UploadDir
	if uploadDir == "" {
		uploadDir = "./files"
	}

	if config.Theme == "" {
		config.Theme = "minimal"
	}

	log.Println("[配置] 加载成功")
}

func getDefaultConfig() Config {
	return Config{
		AdminPassword: "7428",
		Features: Features{
			MemoryStreaming: true,
			ServerStorage:   true,
			P2PDirect:       true,
		},
		StorageConfig: StorageConfig{
			UploadDir:          "./files",
			MaxStorageSize:     10 * 1024 * 1024 * 1024,
			FileRetentionHours: 24,
			DeleteOnDownload:   false,
			NeverDelete:        false,
		},
		Security: Security{
			MaxCodeAttempts:  10,
			SessionTimeout:   1800000,
			AdminTokenExpiry: 3600000,
		},
		Stats: AdminStats{
			TotalTransfers: 0,
			TodayTransfers: 0,
			TodayDate:      time.Now().Format("2006-01-02"),
		},
		Theme: "minimal",
	}
}

func saveConfig() {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		log.Printf("[配置] 保存失败: %v", err)
		return
	}
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		log.Printf("[配置] 保存失败: %v", err)
	}
}

func loadStorageIndex() {
	data, err := os.ReadFile(storageIndexPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[存储索引] 读取失败: %v", err)
		}
		storedFiles = make(map[string]*FileSession)
		return
	}

	var index StorageIndex
	if err := json.Unmarshal(data, &index); err != nil {
		log.Printf("[存储索引] 解析失败，已重置为空: %v", err)
		storedFiles = make(map[string]*FileSession)
		return
	}

	if index.Files == nil {
		storedFiles = make(map[string]*FileSession)
		return
	}

	storedFiles = index.Files
}

func saveStorageIndex() {
	index := StorageIndex{Files: storedFiles}
	data, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		log.Printf("[存储索引] 序列化失败: %v", err)
		return
	}
	if err := os.WriteFile(storageIndexPath, data, 0644); err != nil {
		log.Printf("[存储索引] 保存失败: %v", err)
	}
}

func refreshLegacyFileHashesAndPersist() {
	storedFilesMu.Lock()
	defer storedFilesMu.Unlock()

	updated := false
	for code, file := range storedFiles {
		if file == nil {
			continue
		}
		if file.FileHash != "" {
			continue
		}
		filePath := filepath.Join(uploadDir, file.FileName)
		hash, err := computeFileSHA256(filePath)
		if err != nil {
			continue
		}
		file.FileHash = hash
		storedFiles[code] = file
		updated = true
	}

	if updated {
		saveStorageIndex()
	}
}

// ==================== 清理例程 ====================
func cleanupRoutine() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		now := time.Now()

		// 清理过期会话
		activeSessionsMu.Lock()
		for code, session := range activeSessions {
			// 只清理没有接收端连接的会话（场景一：等待接收端）
			// 有接收端连接的会话由 WebSocket 断开时自动清理
			if session.ReceiverSocketID == "" && now.Sub(session.LastActiveAt) > time.Duration(config.Security.SessionTimeout)*time.Millisecond {
				delete(activeSessions, code)
				log.Printf("[清理] 移除过期会话: %s (发送端心跳超时)", code)
			}
		}
		activeSessionsMu.Unlock()

		// 清理过期文件
		storedFilesMu.Lock()
		for code, file := range storedFiles {
			if !file.DeleteTime.IsZero() && now.After(file.DeleteTime) {
				deleteStoredFile(code)
				log.Printf("[清理] 移除过期文件: %s", code)
			}
		}
		storedFilesMu.Unlock()

		// 清理过期 admin token
		adminTokensMu.Lock()
		for token, admin := range adminTokens {
			if now.After(admin.ExpiresAt) {
				delete(adminTokens, token)
			}
		}
		adminTokensMu.Unlock()
	}
}

func deleteStoredFile(code string) {
	file, exists := storedFiles[code]
	if !exists {
		return
	}

	filePath := filepath.Join(uploadDir, file.FileName)
	if _, err := os.Stat(filePath); err == nil {
		os.Remove(filePath)
		log.Printf("[文件] 已删除: %s (%s)", code, file.OriginalName)
	}
	delete(storedFiles, code)
	saveStorageIndex()
}

// ==================== 工具函数 ====================
func generatePickupCode() string {
	b := make([]byte, 4)
	for i := range b {
		randByte := make([]byte, 1)
		rand.Read(randByte)
		b[i] = letterBytes[int(randByte[0])%len(letterBytes)]
	}
	return string(b)
}

func generateUniquePickupCode() string {
	for {
		code := generatePickupCode()
		storedFilesMu.RLock()
		_, inStored := storedFiles[code]
		storedFilesMu.RUnlock()

		activeSessionsMu.RLock()
		_, inActive := activeSessions[code]
		activeSessionsMu.RUnlock()

		if !inStored && !inActive {
			return code
		}
	}
}

func saveUploadedFileAtomicAndHash(src io.Reader, targetPath string) (int64, string, error) {
	tmpPath := targetPath + ".tmp"
	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		return 0, "", err
	}

	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(tmpFile, hasher), src)
	syncErr := tmpFile.Sync()
	closeErr := tmpFile.Close()

	if copyErr != nil || syncErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		if copyErr != nil {
			return 0, "", copyErr
		}
		if syncErr != nil {
			return 0, "", syncErr
		}
		return 0, "", closeErr
	}

	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		return 0, "", err
	}

	fileHash := hex.EncodeToString(hasher.Sum(nil))
	return written, fileHash, nil
}

func computeFileSHA256(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func hashPassword(password string) string {
	hash := sha256.Sum256([]byte(password))
	return hex.EncodeToString(hash[:])
}

func formatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB", "TB"}
	i := int(math.Log(float64(bytes)) / math.Log(1024))
	return fmt.Sprintf("%.2f %s", float64(bytes)/math.Pow(1024, float64(i)), sizes[i])
}

func normalizeTodayLocked() {
	today := time.Now().Format("2006-01-02")
	if config.Stats.TodayDate != today {
		config.Stats.TodayDate = today
		config.Stats.TodayTransfers = 0
	}
}

func recordTransfer() {
	statsMu.Lock()
	normalizeTodayLocked()
	config.Stats.TotalTransfers++
	config.Stats.TodayTransfers++
	statsMu.Unlock()
	saveConfig()
}

func getStatsSnapshot() AdminStats {
	statsMu.Lock()
	normalizeTodayLocked()
	snapshot := config.Stats
	statsMu.Unlock()
	return snapshot
}

func cleanPath(path string) string {
	// 移除 .html 后缀
	path = strings.TrimSuffix(path, ".html")
	// 确保以 / 开头
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

// ==================== HTTP 处理器 ====================
// 注意：API 路由使用 ServeMux 自动匹配，无需在此处理
// Go 1.22+ 会进行最长路径匹配，/api/features 会优先于 / 匹配
func staticHandler(w http.ResponseWriter, r *http.Request) {
	path := cleanPath(r.URL.Path)

	// 根路径
	if path == "/" {
		http.ServeFile(w, r, "./public/index.html")
		return
	}

	// 静态文件 - 先尝试直接路径，再尝试 .html 后缀
	filePath := "./public" + path

	// 检查直接路径（目录）
	if strings.HasSuffix(path, "/") {
		if _, err := os.Stat(filePath); err == nil {
			http.ServeFile(w, r, filePath+"index.html")
			return
		}
	}

	// 检查直接路径（文件）
	if _, err := os.Stat(filePath); err == nil {
		http.ServeFile(w, r, filePath)
		return
	}

	// 尝试添加 .html 后缀
	htmlPath := filePath + ".html"
	if _, err := os.Stat(htmlPath); err == nil {
		http.ServeFile(w, r, htmlPath)
		return
	}

	// 自定义 404 页面
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	notFoundPage, err := os.ReadFile("./public/404.html")
	if err != nil {
		w.Write([]byte("404 page not found"))
		return
	}
	w.Write(notFoundPage)
}

// ==================== API 处理器 ====================

// 上传文件
func uploadFileHandler(w http.ResponseWriter, r *http.Request) {
	if !config.Features.ServerStorage {
		http.Error(w, `{"success":false,"message":"服务器存储功能已禁用"}`, http.StatusForbidden)
		return
	}

	if err := r.ParseMultipartForm(maxFileSize); err != nil {
		http.Error(w, `{"success":false,"message":"文件过大"}`, http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, `{"success":false,"message":"无法读取文件"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 检查存储空间（优先按声明大小预判）
	usedSpace := getUsedStorage()
	declaredSize := header.Size
	if config.StorageConfig.MaxStorageSize > 0 {
		if declaredSize > 0 && usedSpace+declaredSize > config.StorageConfig.MaxStorageSize {
			http.Error(w, `{"success":false,"message":"存储空间不足"}`, http.StatusForbidden)
			return
		}
		if usedSpace >= config.StorageConfig.MaxStorageSize {
			http.Error(w, `{"success":false,"message":"存储空间已满"}`, http.StatusForbidden)
			return
		}
	}

	// 生成唯一文件名和取件码
	uniqueName := fmt.Sprintf("%d_%s", time.Now().UnixNano(), sanitizeFilename(header.Filename))
	pickupCode := generateUniquePickupCode()

	// 临时写入 + 原子重命名 + 计算哈希
	filePath := filepath.Join(uploadDir, uniqueName)
	written, fileHash, err := saveUploadedFileAtomicAndHash(file, filePath)
	if err != nil {
		http.Error(w, `{"success":false,"message":"写入文件失败"}`, http.StatusInternalServerError)
		return
	}

	if config.StorageConfig.MaxStorageSize > 0 && usedSpace+written > config.StorageConfig.MaxStorageSize {
		_ = os.Remove(filePath)
		http.Error(w, `{"success":false,"message":"存储空间不足"}`, http.StatusForbidden)
		return
	}

	// 计算删除时间
	deleteTime := time.Now().Add(time.Duration(config.StorageConfig.FileRetentionHours) * time.Hour)
	deleteMode := "timer"
	if config.StorageConfig.NeverDelete {
		deleteTime = time.Time{}
		deleteMode = "never"
	} else if config.StorageConfig.DeleteOnDownload {
		deleteMode = "download"
	}

	// 保存会话
	now := time.Now()
	storedFilesMu.Lock()
	storedFiles[pickupCode] = &FileSession{
		PickupCode:   pickupCode,
		FileName:     uniqueName,
		OriginalName: header.Filename,
		Size:         written,
		FileHash:     fileHash,
		UploadTime:   now,
		DeleteTime:   deleteTime,
		DeleteMode:   deleteMode,
	}
	saveStorageIndex()
	storedFilesMu.Unlock()
	recordTransfer()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":          true,
		"pickupCode":       pickupCode,
		"fileName":         header.Filename,
		"size":             written,
		"fileHash":         fileHash,
		"deleteMode":       deleteMode,
		"neverDelete":      config.StorageConfig.NeverDelete,
		"deleteOnDownload": config.StorageConfig.DeleteOnDownload,
		"retentionHours":   config.StorageConfig.FileRetentionHours,
	})
}

// 分块上传接口
func handleChunkUpload(w http.ResponseWriter, r *http.Request) {
	if !config.Features.ServerStorage {
		http.Error(w, `{"success":false,"message":"服务器存储功能已禁用"}`, http.StatusForbidden)
		return
	}

	if err := r.ParseMultipartForm(10 * 1024 * 1024); err != nil { // 10MB max per chunk
		http.Error(w, `{"success":false,"message":"块过大"}`, http.StatusBadRequest)
		return
	}

	fileID := r.FormValue("fileID")
	chunkIndexStr := r.FormValue("chunkIndex")
	totalChunksStr := r.FormValue("totalChunks")

	if fileID == "" || chunkIndexStr == "" || totalChunksStr == "" {
		http.Error(w, `{"success":false,"message":"参数缺失"}`, http.StatusBadRequest)
		return
	}

	chunkIndex, err := strconv.Atoi(chunkIndexStr)
	if err != nil {
		http.Error(w, `{"success":false,"message":"块索引无效"}`, http.StatusBadRequest)
		return
	}

	totalChunks, err := strconv.Atoi(totalChunksStr)
	if err != nil {
		http.Error(w, `{"success":false,"message":"总块数无效"}`, http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("chunk")
	if err != nil {
		http.Error(w, `{"success":false,"message":"无法读取块"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 创建临时目录
	chunkDir := filepath.Join(uploadDir, "chunks", fileID)
	if err := os.MkdirAll(chunkDir, 0755); err != nil {
		http.Error(w, `{"success":false,"message":"创建临时目录失败"}`, http.StatusInternalServerError)
		return
	}

	// 保存块
	chunkPath := filepath.Join(chunkDir, fmt.Sprintf("%d", chunkIndex))
	chunkFile, err := os.Create(chunkPath)
	if err != nil {
		http.Error(w, `{"success":false,"message":"创建块文件失败"}`, http.StatusInternalServerError)
		return
	}
	defer chunkFile.Close()

	if _, err := io.Copy(chunkFile, file); err != nil {
		http.Error(w, `{"success":false,"message":"写入块失败"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"chunkIndex":  chunkIndex,
		"totalChunks": totalChunks,
	})
}

// 合并分块接口
func handleMergeChunks(w http.ResponseWriter, r *http.Request) {
	if !config.Features.ServerStorage {
		http.Error(w, `{"success":false,"message":"服务器存储功能已禁用"}`, http.StatusForbidden)
		return
	}

	var req struct {
		FileID      string `json:"fileID"`
		TotalChunks int    `json:"totalChunks"`
		FileName    string `json:"fileName"`
		FileSize    int64  `json:"fileSize"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"success":false,"message":"请求格式错误"}`, http.StatusBadRequest)
		return
	}

	chunkDir := filepath.Join(uploadDir, "chunks", req.FileID)

	// 检查所有块是否存在
	for i := 0; i < req.TotalChunks; i++ {
		chunkPath := filepath.Join(chunkDir, fmt.Sprintf("%d", i))
		if _, err := os.Stat(chunkPath); os.IsNotExist(err) {
			http.Error(w, fmt.Sprintf(`{"success":false,"message":"块 %d 缺失"}`, i), http.StatusBadRequest)
			return
		}
	}

	// 生成唯一文件名
	uniqueName := fmt.Sprintf("%d_%s", time.Now().UnixNano(), sanitizeFilename(req.FileName))
	filePath := filepath.Join(uploadDir, uniqueName)

	// 创建最终文件
	finalFile, err := os.Create(filePath + ".tmp")
	if err != nil {
		http.Error(w, `{"success":false,"message":"创建文件失败"}`, http.StatusInternalServerError)
		return
	}

	hasher := sha256.New()
	writer := io.MultiWriter(finalFile, hasher)

	// 按顺序合并所有块
	for i := 0; i < req.TotalChunks; i++ {
		chunkPath := filepath.Join(chunkDir, fmt.Sprintf("%d", i))
		chunkFile, err := os.Open(chunkPath)
		if err != nil {
			finalFile.Close()
			os.Remove(filePath + ".tmp")
			http.Error(w, fmt.Sprintf(`{"success":false,"message":"读取块 %d 失败"}`, i), http.StatusInternalServerError)
			return
		}

		if _, err := io.Copy(writer, chunkFile); err != nil {
			chunkFile.Close()
			finalFile.Close()
			os.Remove(filePath + ".tmp")
			http.Error(w, fmt.Sprintf(`{"success":false,"message":"合并块 %d 失败"}`, i), http.StatusInternalServerError)
			return
		}
		chunkFile.Close()
	}

	finalFile.Sync()
	finalFile.Close()

	// 原子重命名
	if err := os.Rename(filePath+".tmp", filePath); err != nil {
		os.Remove(filePath + ".tmp")
		http.Error(w, `{"success":false,"message":"重命名文件失败"}`, http.StatusInternalServerError)
		return
	}

	// 计算哈希
	fileHash := hex.EncodeToString(hasher.Sum(nil))

	// 删除临时块目录
	os.RemoveAll(chunkDir)

	// 计算删除时间
	deleteTime := time.Now().Add(time.Duration(config.StorageConfig.FileRetentionHours) * time.Hour)
	deleteMode := "timer"
	if config.StorageConfig.NeverDelete {
		deleteTime = time.Time{}
		deleteMode = "never"
	} else if config.StorageConfig.DeleteOnDownload {
		deleteMode = "download"
	}

	// 保存会话
	now := time.Now()
	storedFilesMu.Lock()
	storedFiles[req.FileID] = &FileSession{
		PickupCode:   req.FileID,
		FileName:     uniqueName,
		OriginalName: req.FileName,
		Size:         req.FileSize,
		FileHash:     fileHash,
		UploadTime:   now,
		DeleteTime:   deleteTime,
		DeleteMode:   deleteMode,
	}
	saveStorageIndex()
	storedFilesMu.Unlock()
	recordTransfer()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"pickupCode": req.FileID,
		"fileName":   req.FileName,
		"size":       req.FileSize,
		"fileHash":   fileHash,
		"deleteMode": deleteMode,
	})
}

func sanitizeFilename(name string) string {
	// 移除危险字符
	reg := regexp.MustCompile(`[^\w\-\.]`)
	return reg.ReplaceAllString(name, "_")
}

// 获取存储使用量
func getUsedStorage() int64 {
	var total int64
	storedFilesMu.RLock()
	defer storedFilesMu.RUnlock()

	for _, file := range storedFiles {
		filePath := filepath.Join(uploadDir, file.FileName)
		if info, err := os.Stat(filePath); err == nil {
			total += info.Size()
		}
	}
	return total
}

// 下载存储的文件（支持 Range 请求）
func downloadStoredHandler(w http.ResponseWriter, r *http.Request) {
	if !config.Features.ServerStorage {
		http.Error(w, `{"success":false,"message":"服务器存储功能已禁用"}`, http.StatusForbidden)
		return
	}

	code := filepath.Base(r.URL.Path)
	codeAttemptsMu.Lock()
	attempts := codeAttempts[code]
	if attempts >= config.Security.MaxCodeAttempts {
		codeAttemptsMu.Unlock()
		http.Error(w, `{"success":false,"message":"取件码已锁定"}`, http.StatusForbidden)
		return
	}
	codeAttemptsMu.Unlock()

	storedFilesMu.RLock()
	file, exists := storedFiles[code]
	if !exists {
		codeAttemptsMu.Lock()
		codeAttempts[code]++
		codeAttemptsMu.Unlock()
		storedFilesMu.RUnlock()
		http.Error(w, `{"success":false,"message":"取件码无效或文件已过期"}`, http.StatusNotFound)
		return
	}
	storedFilesMu.RUnlock()

	// 检查删除模式
	if file.DeleteMode == "download" {
		defer func() {
			storedFilesMu.Lock()
			deleteStoredFile(code)
			storedFilesMu.Unlock()
		}()
	}

	filePath := filepath.Join(uploadDir, file.FileName)

	// 打开文件
	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, `{"success":false,"message":"文件不存在"}`, http.StatusNotFound)
		return
	}
	defer f.Close()

	// 获取文件信息
	fileInfo, err := f.Stat()
	if err != nil {
		http.Error(w, `{"success":false,"message":"获取文件信息失败"}`, http.StatusInternalServerError)
		return
	}
	fileSize := fileInfo.Size()

	// 设置基本头
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, file.OriginalName))
	w.Header().Set("Accept-Ranges", "bytes")
	if file.FileHash != "" {
		w.Header().Set("X-File-SHA256", file.FileHash)
	}

	// 检查 Range 请求
	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		// 没有 Range，返回整个文件
		w.Header().Set("Content-Length", fmt.Sprintf("%d", fileSize))
		w.Header().Set("Content-Type", "application/octet-stream")
		io.Copy(w, f)
		return
	}

	// 解析 Range header (格式: bytes=start-end)
	ranges := strings.TrimPrefix(rangeHeader, "bytes=")
	parts := strings.Split(ranges, "-")
	if len(parts) != 2 {
		http.Error(w, "Invalid Range header", http.StatusBadRequest)
		return
	}

	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		http.Error(w, "Invalid Range start", http.StatusBadRequest)
		return
	}

	var end int64
	if parts[1] == "" {
		end = fileSize - 1
	} else {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			http.Error(w, "Invalid Range end", http.StatusBadRequest)
			return
		}
	}

	// 验证范围
	if start < 0 || end >= fileSize || start > end {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
		http.Error(w, "Range Not Satisfiable", http.StatusRequestedRangeNotSatisfiable)
		return
	}

	// 设置 Range 响应头
	contentLength := end - start + 1
	w.Header().Set("Content-Length", fmt.Sprintf("%d", contentLength))
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusPartialContent)

	// 定位到起始位置
	if _, err := f.Seek(start, 0); err != nil {
		log.Printf("[Range] Seek 失败: %v", err)
		return
	}

	// 发送指定范围的数据
	io.CopyN(w, f, contentLength)
}

// ==================== 健康检查 ====================
func healthHandler(w http.ResponseWriter, r *http.Request) {
	activeSessionsMu.RLock()
	storedFilesMu.RLock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "healthy",
		"activeSessions": len(activeSessions),
		"storedFiles":    len(storedFiles),
		"uptime":         time.Since(startTime).Seconds(),
	})

	storedFilesMu.RUnlock()
	activeSessionsMu.RUnlock()
}

// ==================== HTTP 流下载处理 ====================

// downloadStreamHandler 处理 HTTP 流式下载
// 当接收端不支持 File System Access API 时，通过 iframe 请求此端点进行流式下载
func downloadStreamHandler(w http.ResponseWriter, r *http.Request) {
	// 提取取件码
	code := strings.TrimPrefix(r.URL.Path, "/api/download/")
	if code == "" || code == "/api/download" {
		http.Error(w, "取件码无效", http.StatusBadRequest)
		return
	}

	// 查找会话
	activeSessionsMu.RLock()
	session, exists := activeSessions[code]
	activeSessionsMu.RUnlock()

	if !exists || session == nil {
		http.Error(w, "链接已失效或会话不存在", http.StatusNotFound)
		return
	}

	// 设置下载头
	filename := url.PathEscape(session.FileName)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s; filename*=UTF-8''%s", filename, filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	if session.Size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", session.Size))
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// 检查是否支持 Flusher（用于流式传输）
	if flusher, ok := w.(http.Flusher); ok {
		session.DownloadFlusher = flusher
	}
	session.DownloadResponse = w

	log.Printf("[HTTP流] %s 开始流式下载，文件名: %s, 大小: %d", code, session.FileName, session.Size)

	// 通知发送端开始传输
	notifySenderForHTTPDownload(code)

	// 注意：数据将通过 WebSocket 接收后写入 w
	// 这里不需要直接返回，连接保持打开直到客户端断开或传输完成
}

var startTime time.Time

// ==================== 主函数 ====================
func main() {
	startTime = time.Now()

	// 命令行参数
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "--reset" || os.Args[i] == "-r" {
			resetConfig()
			return
		}
	}

	// 路由
	http.HandleFunc("/", staticHandler)
	http.HandleFunc("/upload", staticHandler)
	http.HandleFunc("/receive", staticHandler)
	http.HandleFunc("/admin", staticHandler)

	// API
	http.HandleFunc("/api/upload-file", uploadFileHandler)
	http.HandleFunc("/api/upload-chunk", handleChunkUpload)
	http.HandleFunc("/api/merge-chunks", handleMergeChunks)
	http.HandleFunc("/api/download-stored/", downloadStoredHandler)
	http.HandleFunc("/api/download/", downloadStreamHandler) // HTTP 流下载
	http.HandleFunc("/api/features", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":       true,
			"features":      config.Features,
			"storageConfig": config.StorageConfig,
			"theme":         config.Theme,
		})
	})
	http.HandleFunc("/api/stored-file/", func(w http.ResponseWriter, r *http.Request) {
		code := filepath.Base(r.URL.Path)
		storedFilesMu.RLock()
		file, exists := storedFiles[code]
		if !exists {
			storedFilesMu.RUnlock()
			http.Error(w, `{"success":false,"message":"取件码无效或文件已过期"}`, http.StatusNotFound)
			return
		}
		storedFilesMu.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":    true,
			"pickupCode": code,
			"fileName":   file.OriginalName,
			"size":       file.Size,
			"fileHash":   file.FileHash,
			"deleteMode": file.DeleteMode,
		})
	})
	http.HandleFunc("/api/pickup-code/", func(w http.ResponseWriter, r *http.Request) {
		code := filepath.Base(r.URL.Path)
		if code == "" || code == "pickup-code" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": false,
				"message": "取件码不能为空",
			})
			return
		}

		activeSessionsMu.RLock()
		session, sessionExists := activeSessions[code]
		activeSessionsMu.RUnlock()
		if sessionExists {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success":    true,
				"exists":     true,
				"pickupCode": code,
				"mode":       session.Mode,
				"fileName":   session.FileName,
				"size":       session.Size,
			})
			return
		}

		storedFilesMu.RLock()
		file, fileExists := storedFiles[code]
		storedFilesMu.RUnlock()
		if fileExists {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success":    true,
				"exists":     true,
				"pickupCode": code,
				"mode":       "storage",
				"fileName":   file.OriginalName,
				"size":       file.Size,
				"fileHash":   file.FileHash,
				"deleteMode": file.DeleteMode,
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":    true,
			"exists":     false,
			"pickupCode": code,
			"mode":       "",
		})
	})

	// 健康检查
	http.HandleFunc("/health", healthHandler)

	// 管理员 API
	setupAdminRoutes()

	// WebSocket
	http.HandleFunc("/ws", wsHandler)

	// 静态文件目录
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(uploadDir))))

	port := getEnvOrDefault("PORT", "3000")
	log.Printf("🚀 File-Rocket 服务器启动成功!")
	log.Printf("📍 访问地址: http://localhost:%s", port)
	log.Printf("🔐 管理后台: 点击首页版权文字 4 次")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}

func getEnvOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func resetConfig() {
	config := getDefaultConfig()
	data, _ := json.MarshalIndent(config, "", "  ")
	os.WriteFile(configPath, data, 0644)
	log.Println("配置已重置为默认值")
}

// ==================== WebSocket 处理器 ====================
func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] 建立连接失败: %v", err)
		return
	}

	socketID := generateToken()[:8]
	log.Printf("[WS] 新连接: %s", socketID)

	client := &WSClient{
		conn:     conn,
		socketID: socketID,
		send:     make(chan OutgoingMessage, 256),
	}

	wsClientsMu.Lock()
	wsClients[socketID] = client
	wsClientsMu.Unlock()

	go client.writePump()
	go client.readPump()
}

type WSClient struct {
	conn            *websocket.Conn
	socketID        string
	send            chan OutgoingMessage
	UploadingFileID string // 跟踪正在进行的分块上传，用于断开时清理
}

type OutgoingMessage struct {
	MessageType int
	Data        []byte
}

func (c *WSClient) readPump() {
	defer func() {
		log.Printf("[WS] 断开连接: %s", c.socketID)
		wsClientsMu.Lock()
		delete(wsClients, c.socketID)
		wsClientsMu.Unlock()
		c.conn.Close()
		cleanupSession(c.socketID)

		// 清理未完成的分块上传
		if c.UploadingFileID != "" {
			chunkDir := filepath.Join(uploadDir, "chunks", c.UploadingFileID)
			if _, err := os.Stat(chunkDir); err == nil {
				os.RemoveAll(chunkDir)
				log.Printf("[清理] 删除未完成的分块上传: %s", c.UploadingFileID)
			}
		}
	}()

	c.conn.SetReadLimit(maxFileSize)
	c.conn.SetReadDeadline(time.Now().Add(time.Duration(config.Security.SessionTimeout) * time.Millisecond))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(time.Duration(config.Security.SessionTimeout) * time.Millisecond))
		return nil
	})

	for {
		messageType, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[WS] 读取错误: %v", err)
			}
			break
		}

		if messageType == websocket.BinaryMessage {
			c.handleBinaryChunk(message)
			continue
		}
		if messageType != websocket.TextMessage {
			continue
		}

		var wsMsg WSMessage
		if err := json.Unmarshal(message, &wsMsg); err != nil {
			log.Printf("[WS] 消息解析错误: %v", err)
			continue
		}

		c.handleMessage(wsMsg)
	}
}

func (c *WSClient) writePump() {
	ticker := time.NewTicker(60 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(message.MessageType, message.Data); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *WSClient) handleMessage(msg WSMessage) {
	switch msg.Type {
	case "create-session":
		c.handleCreateSession(msg)
	case "join-session":
		c.handleJoinSession(msg)
	case "receiver-ready":
		c.handleReceiverReady(msg)
	case "receiver-sink-ready":
		c.handleReceiverSinkReady(msg)
	case "receiver-fatal":
		c.handleReceiverFatal(msg)
	case "signal":
		c.handleSignal(msg)
	case "transfer-start":
		c.handleTransferStart(msg)
	case "chunk-meta":
		c.handleChunkMeta(msg)
	case "chunk-ack":
		c.handleChunkAck(msg)
	case "chunk-nack":
		c.handleChunkNack(msg)
	case "transfer-end":
		c.handleTransferEnd(msg)
	case "transfer-complete":
		c.handleTransferComplete(msg)
	case "verify-ok":
		c.handleVerifyOk(msg)
	case "verify-fail":
		c.handleVerifyFail(msg)
	case "transfer-chunk":
		c.handleTransferChunk(msg)
	case "cancel":
		c.handleCancel(msg)
	case "heartbeat":
		c.handleHeartbeat()
	case "p2p-nat-info":
		c.handleP2PNATInfo(msg)
	case "register-chunk-upload":
		c.handleRegisterChunkUpload(msg)
	case "chunk-upload-complete":
		c.handleChunkUploadComplete(msg)
	}
}

func (c *WSClient) handleCreateSession(msg WSMessage) {
	payload := msg.Payload.(map[string]interface{})
	fileName := payload["fileName"].(string)
	fileSize := int64(payload["fileSize"].(float64))
	mode := payload["mode"].(string)

	if !isModeEnabled(mode) {
		c.sendError("此传输模式已禁用")
		return
	}

	pickupCode := generatePickupCode()

	// 确保取件码唯一
	for {
		activeSessionsMu.RLock()
		_, exists := activeSessions[pickupCode]
		activeSessionsMu.RUnlock()
		if !exists {
			break
		}
		pickupCode = generatePickupCode()
	}

	// 创建传输通道
	transferChanMu.Lock()
	fileTransferChannels[pickupCode] = make(chan []byte, 1024)
	transferChanMu.Unlock()

	now := time.Now()
	session := &ActiveSession{
		SocketID:         c.socketID,
		PickupCode:       pickupCode,
		Mode:             mode,
		FileName:         fileName,
		Size:             fileSize,
		CreatedAt:        now,
		LastActiveAt:     now,
		IsSender:         true,
		ExpectedFileHash: "",
		PendingChunkMeta: make(map[int]map[string]interface{}),
	}

	activeSessionsMu.Lock()
	activeSessions[pickupCode] = session
	activeSessionsMu.Unlock()
	recordTransfer()

	c.sendJSON(WSMessage{
		Type: "session-created",
		Payload: map[string]interface{}{
			"pickupCode": pickupCode,
			"mode":       mode,
		},
	})

	log.Printf("[WS] 会话创建: %s (%s) - %s", pickupCode, mode, formatBytes(fileSize))
}

func (c *WSClient) handleJoinSession(msg WSMessage) {
	payload := msg.Payload.(map[string]interface{})
	pickupCode := payload["pickupCode"].(string)
	mode := payload["mode"].(string)
	capabilities, _ := payload["capabilities"].(map[string]interface{}) // 提取接收端能力

	codeAttemptsMu.Lock()
	if codeAttempts[pickupCode] >= config.Security.MaxCodeAttempts {
		codeAttemptsMu.Unlock()
		c.sendError("取件码已锁定")
		return
	}
	codeAttemptsMu.Unlock()

	activeSessionsMu.RLock()
	session, exists := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()

	if !exists {
		if !isModeEnabled(mode) {
			c.sendError("此传输模式已禁用")
			return
		}

		storedFilesMu.RLock()
		file, fileExists := storedFiles[pickupCode]
		storedFilesMu.RUnlock()

		if !fileExists {
			codeAttemptsMu.Lock()
			codeAttempts[pickupCode]++
			codeAttemptsMu.Unlock()
			c.sendError("取件码无效")
			return
		}

		// 服务器存储模式
		c.sendJSON(WSMessage{
			Type: "storage-mode",
			Payload: map[string]interface{}{
				"pickupCode": pickupCode,
				"fileName":   file.OriginalName,
				"size":       file.Size,
			},
		})
		log.Printf("[WS] 存储模式连接: %s", pickupCode)
		return
	}

	// 更新会话中的接收者 / 模式回退
	activeSessionsMu.Lock()
	if session.ReceiverSocketID == "" {
		session.ReceiverSocketID = c.socketID
	}
	if session.Mode != "" && mode == "memory" && session.Mode == "p2p" {
		log.Printf("[WS] P2P 会话回退到 memory: %s", pickupCode)
		session.Mode = "memory"
	}
	effectiveMode := session.Mode
	activeSessionsMu.Unlock()

	// 发送会话信息给接收方
	c.sendJSON(WSMessage{
		Type: "session-joined",
		Payload: map[string]interface{}{
			"pickupCode": pickupCode,
			"fileName":   session.FileName,
			"size":       session.Size,
			"mode":       effectiveMode,
		},
	})

	// 通知发送方
	sendToSocket(session.SocketID, WSMessage{
		Type: "receiver-connected",
		Payload: map[string]interface{}{
			"capabilities": capabilities,
		},
	})

	log.Printf("[WS] 加入会话: %s", pickupCode)
}

func (c *WSClient) handleReceiverReady(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || session.ReceiverSocketID != c.socketID {
		return
	}

	sendToSocket(session.SocketID, WSMessage{Type: "receiver-ready"})
}

func (c *WSClient) handleReceiverSinkReady(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || session.ReceiverSocketID != c.socketID {
		return
	}

	sendToSocket(session.SocketID, WSMessage{
		Type:    "receiver-sink-ready",
		Payload: payload,
	})
}

func (c *WSClient) handleReceiverFatal(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || session.ReceiverSocketID != c.socketID {
		return
	}

	sendToSocket(session.SocketID, WSMessage{
		Type:    "receiver-fatal",
		Payload: payload,
	})
}

func (c *WSClient) handleSignal(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil {
		return
	}

	if c.socketID == session.SocketID && session.ReceiverSocketID != "" {
		sendToSocket(session.ReceiverSocketID, WSMessage{
			Type:    "signal",
			Payload: payload,
		})
		return
	}

	if c.socketID == session.ReceiverSocketID && session.SocketID != "" {
		sendToSocket(session.SocketID, WSMessage{
			Type:    "signal",
			Payload: payload,
		})
	}
}

func (c *WSClient) handleP2PNATInfo(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}
	natType, _ := payload["natType"].(map[string]interface{})
	role, _ := payload["role"].(string)
	if natType == nil || role == "" {
		return
	}

	activeSessionsMu.Lock()
	session := activeSessions[pickupCode]
	if session == nil {
		activeSessionsMu.Unlock()
		return
	}

	if role == "sender" && c.socketID == session.SocketID {
		session.SenderNAT = natType
		receiverSocketID := session.ReceiverSocketID
		activeSessionsMu.Unlock()
		if receiverSocketID != "" {
			sendToSocket(receiverSocketID, WSMessage{
				Type: "p2p-nat-info",
				Payload: map[string]interface{}{
					"pickupCode": pickupCode,
					"natType":    natType,
					"role":       "sender",
				},
			})
		}
	} else if role == "receiver" && c.socketID == session.ReceiverSocketID {
		session.ReceiverNAT = natType
		senderSocketID := session.SocketID
		senderNAT := session.SenderNAT
		activeSessionsMu.Unlock()
		if senderSocketID != "" {
			sendToSocket(senderSocketID, WSMessage{
				Type: "p2p-nat-info",
				Payload: map[string]interface{}{
					"pickupCode": pickupCode,
					"natType":    natType,
					"role":       "receiver",
				},
			})
		}
		// 补发发送端 NAT 信息给接收端（解决时序竞争）
		if senderNAT != nil {
			sendToSocket(c.socketID, WSMessage{
				Type: "p2p-nat-info",
				Payload: map[string]interface{}{
					"pickupCode": pickupCode,
					"natType":    senderNAT,
					"role":       "sender",
				},
			})
		}
	} else {
		activeSessionsMu.Unlock()
	}
}

func (c *WSClient) handleRegisterChunkUpload(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	fileID, _ := payload["fileID"].(string)
	if fileID == "" {
		return
	}

	c.UploadingFileID = fileID
	log.Printf("[分块上传] 注册上传会话: %s -> %s", c.socketID, fileID)

	c.sendJSON(WSMessage{
		Type: "chunk-upload-registered",
		Payload: map[string]interface{}{
			"fileID": fileID,
		},
	})
}

func (c *WSClient) handleChunkUploadComplete(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	fileID, _ := payload["fileID"].(string)

	if c.UploadingFileID == fileID || fileID == "" {
		log.Printf("[分块上传] 上传完成，清除跟踪: %s -> %s", c.socketID, c.UploadingFileID)
		c.UploadingFileID = ""
	}
}

func (c *WSClient) getSessionBySocketID(socketID string) (string, *ActiveSession, bool) {
	activeSessionsMu.RLock()
	defer activeSessionsMu.RUnlock()
	for code, session := range activeSessions {
		if session == nil {
			continue
		}
		if session.SocketID == socketID || session.ReceiverSocketID == socketID {
			return code, session, true
		}
	}
	return "", nil, false
}

func (c *WSClient) getSessionBySenderSocket() (string, *ActiveSession) {
	activeSessionsMu.RLock()
	defer activeSessionsMu.RUnlock()
	for code, session := range activeSessions {
		if session != nil && session.SocketID == c.socketID {
			return code, session
		}
	}
	return "", nil
}

func (c *WSClient) handleTransferStart(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, _ = c.getSessionBySenderSocket()
	}

	activeSessionsMu.Lock()
	session := activeSessions[pickupCode]
	if session == nil || session.SocketID != c.socketID || session.ReceiverSocketID == "" {
		activeSessionsMu.Unlock()
		return
	}
	if fileHash, ok := payload["fileHash"].(string); ok {
		session.ExpectedFileHash = strings.ToLower(strings.TrimSpace(fileHash))
	}
	receiverSocketID := session.ReceiverSocketID
	activeSessionsMu.Unlock()

	sendToSocket(receiverSocketID, msg)
}

func (c *WSClient) handleChunkMeta(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, _ = c.getSessionBySenderSocket()
	}

	activeSessionsMu.Lock()
	session := activeSessions[pickupCode]
	if session == nil || session.SocketID != c.socketID || session.ReceiverSocketID == "" {
		activeSessionsMu.Unlock()
		return
	}
	if session.PendingChunkMeta == nil {
		session.PendingChunkMeta = make(map[int]map[string]interface{})
	}
	chunkIndexFloat, ok := payload["chunkIndex"].(float64)
	if !ok {
		activeSessionsMu.Unlock()
		return
	}
	chunkIndex := int(chunkIndexFloat)
	session.PendingChunkMeta[chunkIndex] = payload
	receiverSocketID := session.ReceiverSocketID
	activeSessionsMu.Unlock()

	sendToSocket(receiverSocketID, msg)
}

func (c *WSClient) handleChunkAck(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, session, exists := c.getSessionBySocketID(c.socketID)
		if !exists || session == nil {
			return
		}
		_ = pickupCode
	}

	activeSessionsMu.Lock()
	session := activeSessions[pickupCode]
	if session == nil || session.ReceiverSocketID != c.socketID || session.SocketID == "" {
		activeSessionsMu.Unlock()
		return
	}
	chunkIndexFloat, hasChunkIndex := payload["chunkIndex"].(float64)
	if hasChunkIndex && session.PendingChunkMeta != nil {
		delete(session.PendingChunkMeta, int(chunkIndexFloat))
	}
	senderSocketID := session.SocketID
	receiverSocketID := session.ReceiverSocketID
	shouldFlushEnd := session.PendingTransferEnd && len(session.PendingChunkMeta) == 0
	endPayload := session.TransferEndPayload
	if shouldFlushEnd {
		session.PendingTransferEnd = false
		session.TransferEndPayload = nil
	}
	activeSessionsMu.Unlock()

	sendToSocket(senderSocketID, msg)
	if shouldFlushEnd {
		sendToSocket(receiverSocketID, WSMessage{Type: "transfer-end", Payload: endPayload})
	}
}

func (c *WSClient) handleChunkNack(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, session, exists := c.getSessionBySocketID(c.socketID)
		if !exists || session == nil {
			return
		}
		_ = pickupCode
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || session.ReceiverSocketID != c.socketID || session.SocketID == "" {
		return
	}

	sendToSocket(session.SocketID, WSMessage{
		Type:    "chunk-nack",
		Payload: payload,
	})
}

func (c *WSClient) handleTransferEnd(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, _ = c.getSessionBySenderSocket()
	}

	activeSessionsMu.Lock()
	session := activeSessions[pickupCode]
	if session == nil {
		activeSessionsMu.Unlock()
		return
	}

	// 检查是否是 HTTP 流下载模式
	isHTTPStream := session.DownloadResponse != nil

	// 如果是 HTTP 流模式且没有接收端，结束传输
	if isHTTPStream && session.ReceiverSocketID == "" {
		// 关闭 HTTP 响应
		if h, ok := session.DownloadResponse.(http.Hijacker); ok {
			h.Hijack()
		}
		session.DownloadResponse = nil
		session.DownloadFlusher = nil
		log.Printf("[HTTP流] %s 传输完成，关闭连接", pickupCode)
		activeSessionsMu.Unlock()
		return
	}

	if session.SocketID != c.socketID || session.ReceiverSocketID == "" {
		activeSessionsMu.Unlock()
		return
	}
	receiverSocketID := session.ReceiverSocketID
	pendingCount := len(session.PendingChunkMeta)
	if pendingCount > 0 {
		session.PendingTransferEnd = true
		session.TransferEndPayload = payload
	}
	activeSessionsMu.Unlock()

	if pendingCount > 0 {
		log.Printf("[WS] transfer-end 延迟转发，仍有 %d 个分块未ACK: %s", pendingCount, pickupCode)
		return
	}

	sendToSocket(receiverSocketID, msg)
}

func (c *WSClient) handleTransferChunk(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		pickupCode, _ = c.getSessionBySenderSocket()
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || session.SocketID != c.socketID || session.ReceiverSocketID == "" {
		return
	}

	sendToSocket(session.ReceiverSocketID, msg)
}

func (c *WSClient) handleTransferComplete(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil {
		return
	}

	if c.socketID == session.ReceiverSocketID {
		sendToSocket(session.SocketID, WSMessage{Type: "transfer-complete"})
	}
}

func (c *WSClient) handleVerifyOk(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}
	actualHash := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", payload["actualHash"])))

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || c.socketID != session.ReceiverSocketID {
		return
	}

	expectedHash := strings.ToLower(strings.TrimSpace(session.ExpectedFileHash))
	if expectedHash != "" && actualHash != "" && expectedHash != actualHash {
		sendToSocket(session.SocketID, WSMessage{
			Type: "verify-fail",
			Payload: map[string]interface{}{
				"pickupCode": pickupCode,
				"reason":     fmt.Sprintf("接收端校验值与发送端期望不一致: expected=%s actual=%s", expectedHash, actualHash),
			},
		})
		return
	}

	sendToSocket(session.SocketID, WSMessage{
		Type: "verify-ok",
		Payload: map[string]interface{}{
			"pickupCode": pickupCode,
			"actualHash": actualHash,
		},
	})
}

func (c *WSClient) handleVerifyFail(msg WSMessage) {
	payload, ok := msg.Payload.(map[string]interface{})
	if !ok {
		return
	}
	pickupCode, _ := payload["pickupCode"].(string)
	if pickupCode == "" {
		return
	}

	activeSessionsMu.RLock()
	session := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()
	if session == nil || c.socketID != session.ReceiverSocketID {
		return
	}

	sendToSocket(session.SocketID, WSMessage{
		Type:    "verify-fail",
		Payload: payload,
	})
}

func (c *WSClient) handleBinaryChunk(data []byte) {
	pickupCode, session := c.getSessionBySenderSocket()
	if session == nil || pickupCode == "" {
		return
	}

	// 检查是否是 HTTP 流下载模式
	if session.DownloadResponse != nil && !session.PendingTransferEnd {
		// HTTP 流模式：写入 HTTP 响应
		_, err := session.DownloadResponse.Write(data)
		if err != nil {
			log.Printf("[HTTP流] %s 写入数据失败: %v", pickupCode, err)
			return
		}
		// 立即刷新，让浏览器边传边下载
		if session.DownloadFlusher != nil {
			session.DownloadFlusher.Flush()
		}
		return
	}

	// 普通模式：转发给接收端
	if session.ReceiverSocketID == "" {
		return
	}

	wsClientsMu.RLock()
	receiver, exists := wsClients[session.ReceiverSocketID]
	wsClientsMu.RUnlock()
	if !exists || receiver == nil {
		return
	}

	receiver.sendBinary(data)
}

func (c *WSClient) handleCancel(msg WSMessage) {
	payload := msg.Payload.(map[string]interface{})
	pickupCode := payload["pickupCode"].(string)

	cleanupSession(pickupCode)

	sendToSocketID, _ := payload["socketID"].(string)
	if sendToSocketID != "" {
		sendToSocket(sendToSocketID, WSMessage{Type: "transfer-cancelled"})
	}
}

func (c *WSClient) sendJSON(msg WSMessage) {
	data, _ := json.Marshal(msg)
	select {
	case c.send <- OutgoingMessage{MessageType: websocket.TextMessage, Data: data}:
	default:
		log.Printf("[WS] 发送队列满: %s", c.socketID)
	}
}

func (c *WSClient) sendBinary(data []byte) {
	select {
	case c.send <- OutgoingMessage{MessageType: websocket.BinaryMessage, Data: data}:
	default:
		log.Printf("[WS] 二进制发送队列满: %s", c.socketID)
	}
}

func (c *WSClient) sendError(message string) {
	c.sendJSON(WSMessage{
		Type:    "error",
		Payload: message,
	})
}

func sendToSocket(socketID string, msg WSMessage) {
	wsClientsMu.RLock()
	client, exists := wsClients[socketID]
	wsClientsMu.RUnlock()
	if !exists || client == nil {
		return
	}
	client.sendJSON(msg)
}

// notifySenderForHTTPDownload 通知发送端开始通过 HTTP 流发送数据
func notifySenderForHTTPDownload(pickupCode string) {
	activeSessionsMu.RLock()
	session, exists := activeSessions[pickupCode]
	activeSessionsMu.RUnlock()

	if !exists || session == nil {
		log.Printf("[HTTP流] %s 会话不存在", pickupCode)
		return
	}

	// 通知发送端开始传输，数据将通过 WebSocket 发送到服务器，然后写入 HTTP 响应
	if session.SocketID != "" {
		sendToSocket(session.SocketID, WSMessage{
			Type: "start-transfer",
			Payload: map[string]interface{}{
				"pickupCode": pickupCode,
				"dataPlane":  "http-stream", // 标记为 HTTP 流模式
			},
		})
		log.Printf("[HTTP流] %s 已通知发送端开始传输", pickupCode)
	}
}

func cleanupSession(socketID string) {
	activeSessionsMu.Lock()
	defer activeSessionsMu.Unlock()

	for code, session := range activeSessions {
		if session.SocketID == socketID || session.ReceiverSocketID == socketID {
			role := "sender"
			if session.ReceiverSocketID == socketID {
				role = "receiver"
			}

			delete(activeSessions, code)
			log.Printf("[WS] 清理会话: %s (由 %s 断开)", code, role)

			transferChanMu.Lock()
			delete(fileTransferChannels, code)
			transferChanMu.Unlock()
			break
		}
	}
}

func (c *WSClient) handleHeartbeat() {
	// 重置 WebSocket 读超时，防止 Pong 丢失导致连接断开
	c.conn.SetReadDeadline(time.Now().Add(time.Duration(config.Security.SessionTimeout) * time.Millisecond))

	activeSessionsMu.Lock()
	defer activeSessionsMu.Unlock()

	for _, session := range activeSessions {
		if session.SocketID == c.socketID {
			session.LastActiveAt = time.Now()
			break
		}
	}
}

func isModeEnabled(mode string) bool {
	switch mode {
	case "memory":
		return config.Features.MemoryStreaming
	case "storage":
		return config.Features.ServerStorage
	case "p2p":
		return config.Features.P2PDirect
	}
	return false
}

// ==================== 管理员路由 ====================
func setupAdminRoutes() {
	// 登录
	http.HandleFunc("/api/admin/login", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"success":false,"message":"请求格式错误"}`, http.StatusBadRequest)
			return
		}

		// 简单密码验证（生产环境应使用 bcrypt）
		if req.Password != config.AdminPassword && hashPassword(req.Password) != config.AdminPasswordHash {
			http.Error(w, `{"success":false,"message":"密码错误"}`, http.StatusUnauthorized)
			return
		}

		token := generateToken()
		adminTokensMu.Lock()
		adminTokens[token] = &AdminToken{
			Token:     token,
			ExpiresAt: time.Now().Add(time.Duration(config.Security.AdminTokenExpiry) * time.Millisecond),
		}
		adminTokensMu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
			"token":   token,
		})
	})

	// 获取/更新配置（根据请求方法区分）
	http.HandleFunc("/api/admin/config", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		switch r.Method {
		case "GET":
			stats := getStatsSnapshot()
			storedFilesMu.RLock()
			storedCount := len(storedFiles)
			storedFilesMu.RUnlock()

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success":       true,
				"features":      config.Features,
				"storageConfig": config.StorageConfig,
				"theme":         config.Theme,
				"stats": map[string]interface{}{
					"totalTransfers": stats.TotalTransfers,
					"todayTransfers": stats.TodayTransfers,
					"storedFiles":    storedCount,
				},
			})

		case "PUT", "POST":
			var req map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, `{"success":false,"message":"请求格式错误"}`, http.StatusBadRequest)
				return
			}

			if features, ok := req["features"].(map[string]interface{}); ok {
				if v, ok := features["memoryStreaming"].(bool); ok {
					config.Features.MemoryStreaming = v
				}
				if v, ok := features["serverStorage"].(bool); ok {
					config.Features.ServerStorage = v
				}
				if v, ok := features["p2pDirect"].(bool); ok {
					config.Features.P2PDirect = v
				}
			}

			if theme, ok := req["theme"].(string); ok && (theme == "classic" || theme == "minimal") {
				config.Theme = theme
			}

			saveConfig()

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": true,
			})

		default:
			http.Error(w, `{"success":false,"message":"方法不允许"}`, http.StatusMethodNotAllowed)
		}
	})

	// 更新存储配置
	http.HandleFunc("/api/admin/storage-config", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		var req StorageConfig
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"success":false,"message":"请求格式错误"}`, http.StatusBadRequest)
			return
		}

		config.StorageConfig = req
		saveConfig()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
		})
	})

	// 获取文件列表
	http.HandleFunc("/api/admin/files", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		diskSpace := getDiskSpace()
		storedFilesMu.RLock()

		files := make([]map[string]interface{}, 0, len(storedFiles))
		for code, file := range storedFiles {
			remainingMs := int64(0)
			if !file.DeleteTime.IsZero() {
				remainingMs = int64(time.Until(file.DeleteTime) / time.Millisecond)
			}

			files = append(files, map[string]interface{}{
				"pickupCode":   code,
				"originalName": file.OriginalName,
				"size":         file.Size,
				"uploadTime":   file.UploadTime.UnixMilli(),
				"deleteMode":   file.DeleteMode,
				"remainingMs":  remainingMs,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":   true,
			"files":     files,
			"diskSpace": diskSpace,
			"totalSize": getUsedStorage(),
			"uploadDir": getAbsoluteUploadDir(),
		})

		storedFilesMu.RUnlock()
	})

	// 删除文件
	http.HandleFunc("/api/admin/files/", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		code := filepath.Base(r.URL.Path)
		storedFilesMu.Lock()
		if _, exists := storedFiles[code]; exists {
			deleteStoredFile(code)
			storedFilesMu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"success": true,
			})
		} else {
			storedFilesMu.Unlock()
			http.Error(w, `{"success":false,"message":"文件不存在"}`, http.StatusNotFound)
		}
	})

	// 删除所有文件
	http.HandleFunc("/api/admin/files/all", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		// 清空 storedFiles 记录
		storedFilesMu.Lock()
		count := len(storedFiles)
		storedFiles = make(map[string]*FileSession)
		storedFilesMu.Unlock()
		saveStorageIndex()

		// 删除 uploadDir 内所有内容（包括 chunks 目录），然后重建空目录
		if err := os.RemoveAll(uploadDir); err != nil {
			log.Printf("[管理] 删除文件目录失败: %v", err)
		}
		os.MkdirAll(uploadDir, 0755)
		log.Printf("[管理] 已清空所有文件，共 %d 条记录", count)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success":      true,
			"deletedCount": count,
		})
	})

	// 修改密码
	http.HandleFunc("/api/admin/change-password", func(w http.ResponseWriter, r *http.Request) {
		if !checkAdminToken(r) {
			http.Error(w, `{"success":false,"message":"未授权"}`, http.StatusUnauthorized)
			return
		}

		var req struct {
			CurrentPassword string `json:"currentPassword"`
			NewPassword     string `json:"newPassword"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"success":false,"message":"请求格式错误"}`, http.StatusBadRequest)
			return
		}

		if req.CurrentPassword != config.AdminPassword && hashPassword(req.CurrentPassword) != config.AdminPasswordHash {
			http.Error(w, `{"success":false,"message":"当前密码错误"}`, http.StatusUnauthorized)
			return
		}

		config.AdminPassword = req.NewPassword
		saveConfig()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": true,
		})
	})
}

func checkAdminToken(r *http.Request) bool {
	token := r.Header.Get("X-Admin-Token")
	if token == "" {
		return false
	}

	adminTokensMu.RLock()
	admin, exists := adminTokens[token]
	adminTokensMu.RUnlock()

	if !exists || time.Now().After(admin.ExpiresAt) {
		return false
	}

	return true
}

func getDiskSpace() map[string]int64 {
	diskSpace := map[string]int64{
		"total": 0,
		"free":  0,
		"used":  0,
	}

	total, free, err := getRealDiskSpace(uploadDir)
	if err != nil {
		used := getUsedStorage()
		diskSpace["total"] = config.StorageConfig.MaxStorageSize
		diskSpace["used"] = used
		diskSpace["free"] = maxInt64(config.StorageConfig.MaxStorageSize-used, 0)
		return diskSpace
	}

	used := total - free
	if used < 0 {
		used = 0
	}

	diskSpace["total"] = total
	diskSpace["free"] = free
	diskSpace["used"] = used

	return diskSpace
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func getAbsoluteUploadDir() string {
	absPath, err := filepath.Abs(uploadDir)
	if err != nil {
		return uploadDir
	}
	return absPath
}
