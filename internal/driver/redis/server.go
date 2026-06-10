package redis

import (
	"context"
	"strings"
)

// parseInfo parses INFO output into section → key/value maps. Lines beginning
// with '#' start a new section; blank lines are ignored.
func parseInfo(raw string) map[string]map[string]string {
	out := map[string]map[string]string{}
	section := "default"
	out[section] = map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			section = strings.TrimSpace(strings.TrimPrefix(line, "#"))
			if _, ok := out[section]; !ok {
				out[section] = map[string]string{}
			}
			continue
		}
		idx := strings.IndexByte(line, ':')
		if idx < 0 {
			continue
		}
		out[section][line[:idx]] = line[idx+1:]
	}
	return out
}

// ServerInfo returns the parsed INFO output for all sections.
func (d *Driver) ServerInfo(ctx context.Context) (map[string]map[string]string, error) {
	raw, err := d.client.Info(ctx).Result()
	if err != nil {
		return nil, err
	}
	return parseInfo(raw), nil
}

// SlowLog returns the most recent slow-log entries.
func (d *Driver) SlowLog(ctx context.Context, count int64) ([]SlowLogEntry, error) {
	if count <= 0 {
		count = 64
	}
	logs, err := d.client.SlowLogGet(ctx, count).Result()
	if err != nil {
		return nil, err
	}
	out := make([]SlowLogEntry, 0, len(logs))
	for _, l := range logs {
		out = append(out, SlowLogEntry{
			ID:       l.ID,
			Time:     l.Time.Unix(),
			Duration: int64(l.Duration.Microseconds()),
			Args:     l.Args,
			Client:   l.ClientAddr,
			Name:     l.ClientName,
		})
	}
	return out, nil
}

// ClientList returns the raw CLIENT LIST output split into per-client lines.
func (d *Driver) ClientList(ctx context.Context) ([]string, error) {
	raw, err := d.client.ClientList(ctx).Result()
	if err != nil {
		return nil, err
	}
	lines := []string{}
	for _, l := range strings.Split(raw, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	return lines, nil
}
