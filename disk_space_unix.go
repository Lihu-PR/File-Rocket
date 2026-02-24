//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

func getRealDiskSpace(path string) (int64, int64, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}

	if _, err := os.Stat(absPath); err != nil {
		return 0, 0, err
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs(absPath, &stat); err != nil {
		return 0, 0, err
	}

	total := int64(stat.Blocks) * int64(stat.Bsize)
	free := int64(stat.Bavail) * int64(stat.Bsize)
	return total, free, nil
}
