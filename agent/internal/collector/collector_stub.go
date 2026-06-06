//go:build !linux

package collector

import (
	"os"
	"runtime"
	"time"
)

// Snapshot is the result of one collection pass.
type Snapshot struct {
	Timestamp    time.Time
	Hostname     string
	Platform     PlatformInfo
	UptimeSec    int64
	CPU          CPUInfo
	Memory       MemoryInfo
	Swap         MemoryInfo
	Load         LoadInfo
	Disk         DiskInfo
	Network      NetworkInfo
	ProcessCount int
	SystemHealth SystemHealthInfo
}

type CPUInfo struct {
	Usage  float64
	IOWait float64
	Steal  float64
	Cores  []float64
}

type MemoryInfo struct {
	Total uint64
	Used  uint64
	Usage float64
}

type LoadInfo struct {
	Load1  float64
	Load5  float64
	Load15 float64
}

type DiskInfo struct {
	Total uint64
	Used  uint64
	Usage float64
}

type NetworkInfo struct {
	RxBytes uint64
	TxBytes uint64
	RxBps   float64
	TxBps   float64
}

type PlatformInfo struct {
	OS         string
	Arch       string
	Kernel     string
	DistroID   string
	VersionID  string
	PrettyName string
}

type SystemHealthInfo struct {
	Network  SystemNetworkInfo
	Process  SystemProcessInfo
	Service  SystemServiceInfo
	Logs     SystemLogsInfo
	Security SystemSecurityInfo
}

type SystemNetworkInfo struct {
	ListeningPortCount int
	TCPConnectionCount int
	TopListeningPorts  []ListeningPortInfo
}

type ListeningPortInfo struct {
	Protocol string `json:"protocol"`
	Port     string `json:"port"`
	Process  string `json:"process"`
}

type SystemProcessInfo struct {
	ZombieCount int
}

type SystemServiceInfo struct {
	FailedServiceCount int
	FailedServices     []string
}

type SystemLogsInfo struct {
	RecentErrorCount int
	RecentErrors     []string
}

type SystemSecurityInfo struct {
	FirewallState string
	SELinuxState  string
}

// Collect returns a minimal snapshot on non-Linux platforms so the package
// remains buildable for local development. Release binaries target Linux.
func Collect() (Snapshot, error) {
	hostname, _ := os.Hostname()
	return Snapshot{
		Timestamp: time.Now().UTC(),
		Hostname:  hostname,
		Platform: PlatformInfo{
			OS:   runtime.GOOS,
			Arch: runtime.GOARCH,
		},
	}, nil
}
