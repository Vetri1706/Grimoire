package main

// This client starts the real local MCP stdio program. MCP tools make real HTTP
// requests to the same Rust/PostgreSQL/MinIO instance as the acceptance harness.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type liveMCP struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Scanner
	cancel context.CancelFunc
	next   int
	stderr bytes.Buffer
}

func (h *harness) startMCP(token string) (*liveMCP, error) {
	node, e := exec.LookPath("node")
	if e != nil {
		return nil, fmt.Errorf("real MCP checks require Node.js: %w", e)
	}
	script := os.Getenv("GRIMOIRE_MCP_SCRIPT")
	if script == "" {
		script = filepath.Join("..", "connectors", "local-mcp.mjs")
	}
	script, e = filepath.Abs(script)
	if e != nil {
		return nil, e
	}
	if _, e = os.Stat(script); e != nil {
		return nil, fmt.Errorf("real MCP adapter unavailable (use GRIMOIRE_MCP_SCRIPT if outside harness directory): %w", e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	m := &liveMCP{cmd: exec.CommandContext(ctx, node, script), cancel: cancel}
	m.cmd.Env = setEnv(setEnv(os.Environ(), "GRIMOIRE_API_URL", h.client.baseURL), "GRIMOIRE_MCP_TOKEN", token)
	m.cmd.Stderr = &m.stderr
	m.stdin, e = m.cmd.StdinPipe()
	if e != nil {
		cancel()
		return nil, e
	}
	stdout, e := m.cmd.StdoutPipe()
	if e != nil {
		cancel()
		return nil, e
	}
	m.reader = bufio.NewScanner(stdout)
	m.reader.Buffer(make([]byte, 4096), 2<<20)
	if e = m.cmd.Start(); e != nil {
		cancel()
		return nil, e
	}
	r, e := m.request("initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "grimoire-go-real-api-harness", "version": "1.0"}})
	if e != nil {
		m.close()
		return nil, e
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if e = json.Unmarshal(r, &init); e != nil || init.ProtocolVersion != "2025-03-26" {
		m.close()
		return nil, fmt.Errorf("unexpected MCP initialize response: %s", r)
	}
	if e = json.NewEncoder(m.stdin).Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); e != nil {
		m.close()
		return nil, e
	}
	return m, nil
}

func (m *liveMCP) close() {
	if m == nil {
		return
	}
	_ = m.stdin.Close()
	m.cancel()
	_ = m.cmd.Wait()
}

func (m *liveMCP) request(method string, params any) (json.RawMessage, error) {
	m.next++
	if e := json.NewEncoder(m.stdin).Encode(map[string]any{"jsonrpc": "2.0", "id": m.next, "method": method, "params": params}); e != nil {
		return nil, e
	}
	if !m.reader.Scan() {
		return nil, fmt.Errorf("MCP subprocess ended before %s response: %v", method, m.reader.Err())
	}
	var response struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if e := json.Unmarshal(m.reader.Bytes(), &response); e != nil {
		return nil, e
	}
	if response.ID != m.next || (len(response.Error) > 0 && string(response.Error) != "null") {
		return nil, fmt.Errorf("MCP %s failed: %s", method, m.reader.Text())
	}
	return response.Result, nil
}

func (m *liveMCP) tool(name string, args map[string]string) (json.RawMessage, bool, error) {
	r, e := m.request("tools/call", map[string]any{"name": name, "arguments": args})
	if e != nil {
		return nil, false, e
	}
	var reply struct {
		IsError bool `json:"isError"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if e = json.Unmarshal(r, &reply); e != nil {
		return nil, false, e
	}
	if len(reply.Content) != 1 || reply.Content[0].Type != "text" || !json.Valid([]byte(reply.Content[0].Text)) {
		return nil, false, fmt.Errorf("MCP did not return one structured JSON text result: %s", r)
	}
	return json.RawMessage(reply.Content[0].Text), reply.IsError, nil
}
