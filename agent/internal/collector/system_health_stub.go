//go:build !linux

package collector

func readSystemHealth() (SystemHealthInfo, error) {
	return SystemHealthInfo{}, nil
}
