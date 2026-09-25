package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type apiClient struct {
	baseURL string
	http    *http.Client
}

type response struct {
	status int
	body   []byte
	header http.Header
}

func (c *apiClient) request(method, path, token string, body any, headers map[string]string) (response, error) {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return response{}, err
		}
	}
	req, err := http.NewRequest(method, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return response{}, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return response{}, err
	}
	defer res.Body.Close()
	data, err = io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return response{}, err
	}
	return response{status: res.StatusCode, body: data, header: res.Header}, nil
}

func expectStatus(res response, want int) error {
	if res.status != want {
		return fmt.Errorf("HTTP %d, want %d; body=%s", res.status, want, res.body)
	}
	return nil
}

func decode[T any](res response) (T, error) {
	var value T
	err := json.Unmarshal(res.body, &value)
	if err != nil {
		return value, fmt.Errorf("invalid response JSON: %w; body=%s", err, res.body)
	}
	return value, nil
}

func newClient(baseURL string) *apiClient {
	return &apiClient{baseURL: baseURL, http: &http.Client{Timeout: 10 * time.Second}}
}
