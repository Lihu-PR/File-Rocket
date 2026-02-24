//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	kernel32DLL            = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceEx = kernel32DLL.NewProc("GetDiskFreeSpaceExW")
)

func getRealDiskSpace(path string) (int64, int64, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}

	if _, err := os.Stat(absPath); err != nil {
		return 0, 0, err
	}

	pathPtr, err := syscall.UTF16PtrFromString(absPath)
	if err != nil {
		return 0, 0, err
	}

	var freeBytesAvailable uint64
	var totalNumberOfBytes uint64
	var totalNumberOfFreeBytes uint64

	ret, _, callErr := procGetDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalNumberOfBytes)),
		uintptr(unsafe.Pointer(&totalNumberOfFreeBytes)),
	)
	if ret == 0 {
		if callErr != nil && callErr != syscall.Errno(0) {
			return 0, 0, callErr
		}
		return 0, 0, syscall.EINVAL
	}

	return int64(totalNumberOfBytes), int64(totalNumberOfFreeBytes), nil
}
