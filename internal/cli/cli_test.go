package cli

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestParseTTL(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", "7d", false},
		{"7d", "7d", false},
		{"1h", "1h", false},
		{"30d", "30d", false},
		{"24h", "24h", false},
		{"31d", "", true},
		{"0d", "", true},
		{"-1h", "", true},
		{"7", "", true},
		{"7x", "", true},
		{"abc", "", true},
		{"7D", "7d", false},
		{"2H", "2h", false},
	}
	for _, tt := range tests {
		got, err := ParseTTL(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("ParseTTL(%q) err=nil, want error", tt.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseTTL(%q) err=%v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("ParseTTL(%q)=%q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestRunFileUpload(t *testing.T) {
	var requests []struct {
		contentType string
		ttl         string
		filename    string
		body        []byte
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		requests = append(requests, struct {
			contentType string
			ttl         string
			filename    string
			body        []byte
		}{r.Header.Get("Content-Type"), r.URL.Query().Get("ttl"), r.Header.Get("X-Download-Filename"), body})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"https://example.test/upload"}`))
	}))
	defer server.Close()
	t.Setenv("CLI_TOOLS_BASE_URL", server.URL)
	t.Setenv("CLI_TOOLS_TOKEN", "test-token")

	path := filepath.Join(t.TempDir(), "payload-☃.bin")
	wantBody := []byte{0, 1, 2, 255}
	if err := os.WriteFile(path, wantBody, 0o600); err != nil {
		t.Fatal(err)
	}

	oldStdout := os.Stdout
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = stdoutWriter
	runErr := runFile([]string{path})
	if runErr == nil {
		runErr = runFile([]string{path, "--ttl", "48h"})
	}
	_ = stdoutWriter.Close()
	os.Stdout = oldStdout
	stdout, readErr := io.ReadAll(stdoutReader)
	_ = stdoutReader.Close()
	if runErr != nil {
		t.Fatal(runErr)
	}
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(stdout) != "https://example.test/upload\nhttps://example.test/upload\n" {
		t.Errorf("stdout=%q, want only upload URLs", stdout)
	}
	if len(requests) != 2 {
		t.Fatalf("got %d requests, want 2", len(requests))
	}
	for i, wantTTL := range []string{"24h", "48h"} {
		got := requests[i]
		if got.contentType != "application/octet-stream" {
			t.Errorf("request %d content type=%q, want application/octet-stream", i, got.contentType)
		}
		if got.ttl != wantTTL {
			t.Errorf("request %d ttl=%q, want %q", i, got.ttl, wantTTL)
		}
		decodedFilename, err := base64.RawURLEncoding.DecodeString(got.filename)
		if err != nil {
			t.Errorf("request %d decode filename header %q: %v", i, got.filename, err)
		} else {
			if string(decodedFilename) != filepath.Base(path) {
				t.Errorf("request %d filename=%q, want %q", i, decodedFilename, filepath.Base(path))
			}
			if base64.RawURLEncoding.EncodeToString(decodedFilename) != got.filename {
				t.Errorf("request %d filename header is not unpadded base64url: %q", i, got.filename)
			}
		}
		if string(got.body) != string(wantBody) {
			t.Errorf("request %d body=%v, want %v", i, got.body, wantBody)
		}
	}
}

func TestValidateFileSize(t *testing.T) {
	tests := []struct {
		size    int64
		wantErr bool
	}{
		{0, true},
		{1, false},
		{maxFileSize, false},
		{maxFileSize + 1, true},
	}
	for _, tt := range tests {
		if err := validateFileSize(tt.size); (err != nil) != tt.wantErr {
			t.Errorf("validateFileSize(%d) error=%v, wantErr %v", tt.size, err, tt.wantErr)
		}
	}
}

func TestContentTypeForVideoExt(t *testing.T) {
	tests := []struct {
		ext  string
		want string
	}{
		{".mp4", "video/mp4"},
		{".m4v", "video/mp4"},
		{".webm", "video/webm"},
		{".mov", "video/quicktime"},
		{".avi", ""},
		{".png", ""},
	}
	for _, tt := range tests {
		if got := contentTypeForVideoExt(tt.ext); got != tt.want {
			t.Errorf("contentTypeForVideoExt(%q)=%q, want %q", tt.ext, got, tt.want)
		}
	}
}

func TestIsPlanExt(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"a.html", true},
		{"a.htm", true},
		{"a.HTML", true},
		{"a.HTM", true},
		{"a.png", false},
		{"html", false},
		{"a.htmlx", false},
		{"/tmp/x.htm", true},
	}
	for _, tt := range tests {
		if got := IsPlanExt(tt.path); got != tt.want {
			t.Errorf("IsPlanExt(%q)=%v, want %v", tt.path, got, tt.want)
		}
	}
}

func TestResolveToken_envWins(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CLI_TOOLS_TOKEN", "from-env")

	// write config that should be ignored
	cfgDir := filepath.Join(dir, "cli-tools")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(Config{Token: "from-file"})
	if err := os.WriteFile(filepath.Join(cfgDir, "config"), b, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveToken()
	if err != nil {
		t.Fatal(err)
	}
	if got != "from-env" {
		t.Fatalf("got %q, want from-env", got)
	}
}

func TestResolveToken_config(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CLI_TOOLS_TOKEN", "")

	cfgDir := filepath.Join(dir, "cli-tools")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(Config{Token: "from-file"})
	if err := os.WriteFile(filepath.Join(cfgDir, "config"), b, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ResolveToken()
	if err != nil {
		t.Fatal(err)
	}
	if got != "from-file" {
		t.Fatalf("got %q, want from-file", got)
	}
}

func TestResolveToken_missing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CLI_TOOLS_TOKEN", "")

	_, err := ResolveToken()
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestIsAnimatedImage(t *testing.T) {
	// VP8X flags byte with animation bit (1<<1)
	animWebP := []byte{
		'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P',
		'V', 'P', '8', 'X', 10, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	}
	if !isAnimatedWebP(animWebP) {
		t.Fatal("expected animated VP8X webp")
	}
	staticWebP := []byte{
		'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P',
		'V', 'P', '8', 'L', 1, 0, 0, 0, 0x2f,
	}
	if isAnimatedWebP(staticWebP) {
		t.Fatal("static webp should not be animated")
	}
	// PNG sig + acTL chunk
	apng := append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a},
		0, 0, 0, 8, 'a', 'c', 'T', 'L', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0) // len=8, type, data, fake crc
	if !isAPNG(apng) {
		t.Fatal("expected APNG via acTL")
	}
	// PNG with only IHDR then IDAT — not animated
	png := append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a},
		0, 0, 0, 0, 'I', 'D', 'A', 'T', 0, 0, 0, 0)
	if isAPNG(png) {
		t.Fatal("static PNG should not be APNG")
	}
}

func TestWriteReadConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CLI_TOOLS_TOKEN", "")

	if err := writeConfig(Config{Token: "abc"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := readConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "abc" {
		t.Fatalf("got %q", cfg.Token)
	}
	// path shape
	want := filepath.Join(dir, "cli-tools", "config")
	if got := configPath(); got != want {
		t.Fatalf("configPath=%q want %q", got, want)
	}
}
