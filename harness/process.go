package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type processLog struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *processLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *processLog) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

type apiProcess struct {
	binary string
	bind   string
	cmd    *exec.Cmd
	done   chan error
	log    *processLog
}

func newProcess(binary, bind string) (*apiProcess, error) {
	abs, err := filepath.Abs(binary)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("Rust API binary: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("Rust API binary is a directory: %s", abs)
	}
	if bind == "" {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		bind = listener.Addr().String()
		listener.Close()
	}
	host, port, err := net.SplitHostPort(bind)
	if err != nil || port == "0" || port == "" {
		return nil, fmt.Errorf("-bind must be a loopback address with a nonzero port")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("-bind must use a loopback IP address")
	}
	return &apiProcess{binary: abs, bind: bind}, nil
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if strings.EqualFold(strings.SplitN(entry, "=", 2)[0], key) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func (p *apiProcess) start(client *apiClient) error {
	if p.cmd != nil {
		return fmt.Errorf("Rust API process is already running")
	}
	p.log = &processLog{}
	p.cmd = exec.Command(p.binary)
	// Fault-injection and database administrator credentials belong to the test
	// controller, never the application process being tested.
	var runtimeEnv []string
	for _, entry := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if strings.HasPrefix(key, "GRIMOIRE_S3_TEST_ADMIN_") || strings.HasPrefix(key, "MINIO_ROOT_") || strings.HasPrefix(key, "GRIMOIRE_TOKEN_") || key == "PGPASSWORD" {
			continue
		}
		runtimeEnv = append(runtimeEnv, entry)
	}
	p.cmd.Env = setEnv(runtimeEnv, "GRIMOIRE_BIND", p.bind)
	p.cmd.Stdout = p.log
	p.cmd.Stderr = p.log
	if err := p.cmd.Start(); err != nil {
		p.cmd = nil
		return fmt.Errorf("start Rust API: %w", err)
	}
	p.done = make(chan error, 1)
	cmd := p.cmd
	go func() { p.done <- cmd.Wait() }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-p.done:
			p.cmd = nil
			return fmt.Errorf("Rust API exited during startup: %v\n%s", err, p.log.String())
		case <-ctx.Done():
			return fmt.Errorf("Rust API health timeout\n%s", p.log.String())
		case <-ticker.C:
			res, err := client.request("GET", "/api/health", "", nil, nil)
			if err == nil && res.status == 200 {
				return nil
			}
		}
	}
}

func (p *apiProcess) stop() error {
	if p.cmd == nil {
		return nil
	}
	select {
	case err := <-p.done:
		p.cmd = nil
		return fmt.Errorf("Rust API had already exited: %v\n%s", err, p.log.String())
	default:
	}
	if err := p.cmd.Process.Kill(); err != nil {
		return fmt.Errorf("stop Rust API: %w", err)
	}
	select {
	case <-p.done:
		p.cmd = nil
		return nil
	case <-time.After(10 * time.Second):
		return fmt.Errorf("Rust API did not exit after termination")
	}
}
