package cli

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/HugoSmits86/nativewebp"
	_ "golang.org/x/image/webp"
)

const (
	defaultBaseURL = "https://cli-tools.cpzhmlb.uk"
	defaultTTL     = "7d"
	maxTTL         = 30 * 24 * time.Hour
	maxPlanSize    = 2 << 20  // 2 MB
	maxImageIn     = 10 << 20 // 10 MB
	maxImageOut    = 5 << 20  // 5 MB
	maxVideoSize        = 50 << 20 // 50 MB upload cap
	videoReencodeOver   = 10 << 20 // re-encode locally if larger
)

type Config struct {
	Token string `json:"token"`
}

// Run is the CLI entry for args after the binary name.
func Run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: cli-tools <auth|plan|image|video> ...")
	}
	switch args[0] {
	case "auth":
		return runAuth(args[1:])
	case "plan":
		return runPlan(args[1:])
	case "image":
		return runImage(args[1:])
	case "video":
		return runVideo(args[1:])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runAuth(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: cli-tools auth <set|status|clear>")
	}
	switch args[0] {
	case "set":
		return authSet(args[1:])
	case "status":
		return authStatus()
	case "clear":
		return authClear()
	default:
		return fmt.Errorf("unknown auth subcommand %q", args[0])
	}
}

func authSet(args []string) error {
	var token string
	if len(args) >= 1 {
		token = strings.TrimSpace(args[0])
	} else {
		sc := bufio.NewScanner(os.Stdin)
		if !sc.Scan() {
			if err := sc.Err(); err != nil {
				return err
			}
			return fmt.Errorf("no token provided")
		}
		token = strings.TrimSpace(sc.Text())
	}
	if token == "" {
		return fmt.Errorf("empty token")
	}
	return writeConfig(Config{Token: token})
}

func authStatus() error {
	if t := os.Getenv("CLI_TOOLS_TOKEN"); t != "" {
		fmt.Println("token: set (env)")
		return nil
	}
	cfg, err := readConfig()
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Println("token: not set")
			return nil
		}
		return err
	}
	if cfg.Token == "" {
		fmt.Println("token: not set")
		return nil
	}
	fmt.Println("token: set (config)")
	return nil
}

func authClear() error {
	path := configPath()
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func configPath() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "cli-tools", "config")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".config", "cli-tools", "config")
	}
	return filepath.Join(home, ".config", "cli-tools", "config")
}

func readConfig() (Config, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("invalid config: %w", err)
	}
	return c, nil
}

func writeConfig(c Config) error {
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	return os.WriteFile(path, b, 0o600)
}

// ResolveToken: CLI_TOOLS_TOKEN env > config > error.
func ResolveToken() (string, error) {
	if t := os.Getenv("CLI_TOOLS_TOKEN"); t != "" {
		return t, nil
	}
	cfg, err := readConfig()
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no token: set CLI_TOOLS_TOKEN or run auth set")
		}
		return "", err
	}
	if cfg.Token == "" {
		return "", fmt.Errorf("no token: set CLI_TOOLS_TOKEN or run auth set")
	}
	return cfg.Token, nil
}

func baseURL() string {
	if u := os.Getenv("CLI_TOOLS_BASE_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return defaultBaseURL
}

// ParseTTL validates Nh/Nd forms, default 7d, max 30d. Returns the input string (or default).
func ParseTTL(s string) (string, error) {
	if s == "" {
		s = defaultTTL
	}
	if len(s) < 2 {
		return "", fmt.Errorf("invalid ttl %q (use Nh or Nd)", s)
	}
	unit := s[len(s)-1]
	n, err := strconv.Atoi(s[:len(s)-1])
	if err != nil || n <= 0 {
		return "", fmt.Errorf("invalid ttl %q (use Nh or Nd)", s)
	}
	var d time.Duration
	switch unit {
	case 'h', 'H':
		d = time.Duration(n) * time.Hour
		s = strconv.Itoa(n) + "h"
	case 'd', 'D':
		d = time.Duration(n) * 24 * time.Hour
		s = strconv.Itoa(n) + "d"
	default:
		return "", fmt.Errorf("invalid ttl %q (use Nh or Nd)", s)
	}
	if d > maxTTL {
		return "", fmt.Errorf("ttl max is 30d")
	}
	return s, nil
}

// IsPlanExt reports whether path is .html/.htm (case-insensitive).
func IsPlanExt(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm":
		return true
	default:
		return false
	}
}

// reorderFlags moves --flags before positionals so `cmd file --ttl 7d` works.
func reorderFlags(args []string) []string {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--no-compress":
			flags = append(flags, a)
		case a == "--ttl" || a == "--quality":
			flags = append(flags, a)
			if i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		case strings.HasPrefix(a, "--ttl=") || strings.HasPrefix(a, "--quality="):
			flags = append(flags, a)
		case strings.HasPrefix(a, "-") && a != "-":
			flags = append(flags, a)
		default:
			pos = append(pos, a)
		}
	}
	return append(flags, pos...)
}

func runPlan(args []string) error {
	fs := flag.NewFlagSet("plan", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	ttlFlag := fs.String("ttl", defaultTTL, "ttl Nh/Nd")
	if err := fs.Parse(reorderFlags(args)); err != nil {
		return fmt.Errorf("plan: %w", err)
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: cli-tools plan <file.html> [--ttl 7d]")
	}
	path := fs.Arg(0)
	if !IsPlanExt(path) {
		return fmt.Errorf("plan requires .html or .htm")
	}
	ttl, err := ParseTTL(*ttlFlag)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(data) > maxPlanSize {
		return fmt.Errorf("plan exceeds 2MB")
	}
	return upload(data, "text/html; charset=utf-8", ttl)
}

func runImage(args []string) error {
	fs := flag.NewFlagSet("image", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	ttlFlag := fs.String("ttl", defaultTTL, "ttl Nh/Nd")
	// nativewebp is VP8L lossless-only; flag accepted for CLI surface / DESIGN.md, ignored on encode
	quality := fs.Int("quality", 80, "webp quality 0-100 (ignored: lossless encode)")
	noCompress := fs.Bool("no-compress", false, "upload original bytes")
	if err := fs.Parse(reorderFlags(args)); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	if *quality < 0 || *quality > 100 {
		return fmt.Errorf("quality must be 0-100")
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: cli-tools image <file> [--ttl 7d] [--quality 80] [--no-compress]")
	}
	path := fs.Arg(0)
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".gif":
		return fmt.Errorf("gif not supported")
	case ".png", ".jpg", ".jpeg", ".webp":
		// ok
	default:
		return fmt.Errorf("image requires png, jpg, jpeg, or webp")
	}
	ttl, err := ParseTTL(*ttlFlag)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(data) > maxImageIn {
		return fmt.Errorf("image exceeds 10MB")
	}

	// reject gif / animated webp / apng by content
	if isGIF(data) {
		return fmt.Errorf("gif not supported")
	}
	if isAnimatedImage(data) {
		return fmt.Errorf("animated images not supported")
	}

	if *noCompress {
		// design: image input 10MB; post-WebP 5MB only applies after encode
		return upload(data, contentTypeForExt(ext), ttl)
	}

	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("decode image: %w", err)
	}
	if format == "gif" {
		return fmt.Errorf("gif not supported")
	}

	var buf bytes.Buffer
	if err := nativewebp.Encode(&buf, img, &nativewebp.Options{CompressionLevel: nativewebp.DefaultCompression}); err != nil {
		return fmt.Errorf("webp encode failed: %w", err)
	}
	out := buf.Bytes()
	if len(out) > maxImageOut {
		return fmt.Errorf("webp exceeds 5MB after encode")
	}
	return upload(out, "image/webp", ttl)
}

// runVideo uploads mp4/webm/mov. Over 10MB: try local ffmpeg re-encode (no CF Stream).
func runVideo(args []string) error {
	fs := flag.NewFlagSet("video", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	ttlFlag := fs.String("ttl", defaultTTL, "ttl Nh/Nd")
	if err := fs.Parse(reorderFlags(args)); err != nil {
		return fmt.Errorf("video: %w", err)
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: cli-tools video <file> [--ttl 7d]")
	}
	path := fs.Arg(0)
	ext := strings.ToLower(filepath.Ext(path))
	ct := contentTypeForVideoExt(ext)
	if ct == "" {
		return fmt.Errorf("video requires mp4, webm, or mov")
	}
	ttl, err := ParseTTL(*ttlFlag)
	if err != nil {
		return err
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if st.Size() == 0 {
		return fmt.Errorf("empty file")
	}
	if st.Size() > maxVideoSize {
		return fmt.Errorf("video exceeds 50MB")
	}

	var data []byte
	if st.Size() > videoReencodeOver {
		enc, err := reencodeVideo(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: re-encode skipped: %v\n", err)
		} else if int64(len(enc)) < st.Size() {
			data = enc
			ct = "video/mp4"
		}
	}
	if data == nil {
		data, err = os.ReadFile(path)
		if err != nil {
			return err
		}
	}
	return upload(data, ct, ttl)
}

// reencodeVideo: H.264/AAC mp4 via system ffmpeg. cap width 1280, crf 28.
func reencodeVideo(src string) ([]byte, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, fmt.Errorf("ffmpeg not found")
	}
	abs, err := filepath.Abs(src)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "cli-tools-video-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	outPath := filepath.Join(dir, "out.mp4")
	// ponytail: fixed crf/scale; expose --crf/--max-width if people need knobs
	cmd := exec.Command(
		"ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
		"-y", "-i", abs,
		"-vf", "scale='min(1280,iw)':-2",
		"-c:v", "libx264", "-crf", "28", "-preset", "medium",
		"-c:a", "aac", "-b:a", "96k",
		"-pix_fmt", "yuv420p",
		"-movflags", "+faststart",
		outPath,
	)
	cmd.Stdout = io.Discard
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return nil, fmt.Errorf("ffmpeg: %s", msg)
	}
	return os.ReadFile(outPath)
}

func contentTypeForVideoExt(ext string) string {
	switch ext {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	default:
		return ""
	}
}

func isGIF(data []byte) bool {
	return bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a"))
}

// isAnimatedImage detects animated WebP (ANIM/ANMF / VP8X anim bit) and APNG (acTL).
func isAnimatedImage(data []byte) bool {
	return isAnimatedWebP(data) || isAPNG(data)
}

func isAnimatedWebP(data []byte) bool {
	if len(data) < 16 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return false
	}
	for i := 12; i+8 <= len(data); {
		tag := string(data[i : i+4])
		size := int(binary.LittleEndian.Uint32(data[i+4 : i+8]))
		payload := i + 8
		if tag == "ANMF" || tag == "ANIM" {
			return true
		}
		if tag == "VP8X" && payload < len(data) && data[payload]&(1<<1) != 0 {
			return true
		}
		i = payload + size
		if size%2 == 1 {
			i++
		}
		if i <= payload {
			return false
		}
	}
	return false
}

func isAPNG(data []byte) bool {
	pngSig := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	if !bytes.HasPrefix(data, pngSig) {
		return false
	}
	for i := 8; i+12 <= len(data); {
		length := int(binary.BigEndian.Uint32(data[i : i+4]))
		ctype := string(data[i+4 : i+8])
		if ctype == "acTL" {
			return true
		}
		if ctype == "IDAT" || ctype == "IEND" {
			return false
		}
		next := i + 12 + length // len + type + data + crc
		if next <= i {
			return false
		}
		i = next
	}
	return false
}

func contentTypeForExt(ext string) string {
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}

type uploadResp struct {
	URL string `json:"url"`
}

func upload(body []byte, contentType, ttl string) error {
	token, err := ResolveToken()
	if err != nil {
		return err
	}
	url := baseURL() + "/v1/upload?ttl=" + ttl
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(respBody))
		if msg == "" {
			msg = resp.Status
		}
		return fmt.Errorf("upload failed (%d): %s", resp.StatusCode, msg)
	}
	var ur uploadResp
	if err := json.Unmarshal(respBody, &ur); err != nil {
		return fmt.Errorf("bad response: %w", err)
	}
	if ur.URL == "" {
		return fmt.Errorf("bad response: missing url")
	}
	fmt.Println(ur.URL)
	return nil
}
