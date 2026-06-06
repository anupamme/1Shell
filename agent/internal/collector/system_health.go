//go:build linux

package collector

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func readSystemHealth() (SystemHealthInfo, error) {
	info := SystemHealthInfo{}
	info.Network.ListeningPortCount, info.Network.TopListeningPorts = readListeningPorts()
	info.Network.TCPConnectionCount = readTCPConnectionCount()
	info.Process.ZombieCount = readZombieCount()
	info.Service.FailedServiceCount, info.Service.FailedServices = readFailedServices()
	info.Logs.RecentErrorCount, info.Logs.RecentErrors = readRecentErrors()
	info.Security.FirewallState = readFirewallState()
	info.Security.SELinuxState = readSELinuxState()
	return info, nil
}

func readListeningPorts() (int, []ListeningPortInfo) {
	out, err := runShortCommand("ss", "-tulnp", "-H")
	if err != nil || strings.TrimSpace(out) == "" {
		return 0, nil
	}
	lines := nonEmptyLines(out)
	ports := make([]ListeningPortInfo, 0, 5)
	for _, line := range lines {
		if len(ports) >= 5 {
			break
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		local := fields[4]
		port := local
		if idx := strings.LastIndex(local, ":"); idx >= 0 && idx < len(local)-1 {
			port = local[idx+1:]
		}
		ports = append(ports, ListeningPortInfo{
			Protocol: fields[0],
			Port:     sanitizeText(port, 32),
			Process:  sanitizeText(extractProcessName(line), 80),
		})
	}
	return len(lines), ports
}

func readTCPConnectionCount() int {
	out, err := runShortCommand("ss", "-tan", "-H")
	if err != nil {
		return 0
	}
	return len(nonEmptyLines(out))
}

func readZombieCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		if !e.IsDir() || !isNumeric(e.Name()) {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		fields := strings.Fields(string(b))
		if len(fields) > 2 && strings.HasPrefix(fields[2], "Z") {
			count++
		}
	}
	return count
}

func readFailedServices() (int, []string) {
	out, err := runShortCommand("systemctl", "--failed", "--no-legend", "--plain")
	if err != nil {
		return 0, nil
	}
	lines := nonEmptyLines(out)
	services := make([]string, 0, 5)
	for _, line := range lines {
		if len(services) >= 5 {
			break
		}
		fields := strings.Fields(line)
		if len(fields) > 0 {
			services = append(services, sanitizeText(fields[0], 120))
		}
	}
	return len(lines), services
}

func readRecentErrors() (int, []string) {
	out, err := runShortCommand("journalctl", "-p", "err..alert", "--since", "1 hour ago", "--no-pager", "-q")
	if err != nil {
		return 0, nil
	}
	lines := nonEmptyLines(out)
	errors := make([]string, 0, 3)
	start := len(lines) - 3
	if start < 0 {
		start = 0
	}
	for _, line := range lines[start:] {
		errors = append(errors, sanitizeText(line, 220))
	}
	return len(lines), errors
}

func readFirewallState() string {
	if out, err := runShortCommand("firewall-cmd", "--state"); err == nil && strings.TrimSpace(out) != "" {
		return sanitizeText(out, 80)
	}
	if out, err := runShortCommand("ufw", "status"); err == nil {
		lines := nonEmptyLines(out)
		if len(lines) > 0 {
			return sanitizeText(lines[0], 80)
		}
	}
	if out, err := runShortCommand("systemctl", "is-active", "firewalld"); err == nil && strings.TrimSpace(out) != "" {
		return sanitizeText(out, 80)
	}
	return "unknown"
}

func readSELinuxState() string {
	out, err := runShortCommand("getenforce")
	if err != nil || strings.TrimSpace(out) == "" {
		return "unknown"
	}
	return sanitizeText(out, 80)
}

func runShortCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func nonEmptyLines(text string) []string {
	lines := []string{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func extractProcessName(line string) string {
	idx := strings.Index(line, "users:((\"")
	if idx >= 0 {
		rest := line[idx+len("users:((\""):]
		end := strings.Index(rest, "\"")
		if end >= 0 {
			return rest[:end]
		}
	}
	idx = strings.Index(line, "users:((\"")
	if idx >= 0 {
		return line[idx:]
	}
	return ""
}

func isNumeric(value string) bool {
	if value == "" {
		return false
	}
	_, err := strconv.Atoi(value)
	return err == nil
}

func sanitizeText(value string, max int) string {
	text := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "|", " "), "=", " "))
	text = strings.Join(strings.Fields(text), " ")
	if max > 0 && len(text) > max {
		return text[:max]
	}
	return text
}
