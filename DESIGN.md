# cli-tools — design (v1)

Personal agent helpers: upload a plan HTML or an image, get a public URL that expires.

## Goals

1. `cli-tools plan <file.html>` → unique public URL
2. `cli-tools image <file>` → WebP → unique public URL
3. Auth setup via CLI; TTL from day one

Non-goals (v1): multi-user, list/delete, CORS/web upload, homelab, CSP, resize, animated images, releases CI, metrics.

## Actors

- **You + your agents only** (single tenant)
- Upload: authenticated
- GET: public (anyone with the link)

## Public surface

| Piece | Value |
|-------|--------|
| Host | `https://cli-tools.cpzhmlb.uk` |
| Object path | `/YYYY-MM-DD/<uuid>` (UTC date of upload, UUID v4) |
| Example | `https://cli-tools.cpzhmlb.uk/2026-07-17/550e8400-e29b-41d4-a716-446655440000` |
| No file extension in URL | Content-Type from stored metadata |

## CLI

- **Language:** Go
- **Binary:** `cli-tools`
- **Install (v1):** `go install` / `go build` from this repo; GitHub releases later
- **Layout:** monorepo with Worker

### Commands

```
cli-tools auth set [token]
cli-tools auth status
cli-tools auth clear

cli-tools plan  <file.html>   [--ttl 7d]
cli-tools image <file>        [--ttl 7d] [--quality 80] [--no-compress]
cli-tools video <file>        [--ttl 7d]
cli-tools file  <file>        [--ttl 24h]
```

### Behavior

| Command | Rules |
|---------|--------|
| `plan` | Local path only; `.html` / `.htm`; upload raw as `text/html; charset=utf-8`; no stdin, no sanitize, no asset rewrite |
| `image` | Accept `png`, `jpg`/`jpeg`, `webp` (static); always re-encode to WebP unless `--no-compress`; default quality 80; no resize; reject gif/animated |
| `video` | Accept mp4, m4v, webm, mov; max 50 MB; try local ffmpeg re-encode above 10 MB |
| `file` | Any non-empty local file; upload raw as `application/octet-stream`; 100 MB max; served as an attachment; default TTL 24h |
| stdout | **URL only** on success |
| stderr | Progress/diagnostics optional; **one line** `error: ...` on failure |
| exit | `0` success; non-zero failure (stdout empty) |

### Flags

- `--ttl` — default `7d` (generic file default `24h`); allow `Nh` / `Nd`; **max 30d**; no forever
- `--quality` — image only, default 80
- `--no-compress` — image only, upload original bytes + original content-type

### Size limits (CLI + Worker)

| Kind | Limit |
|------|--------|
| plan | 2 MB |
| image input | 10 MB |
| image after WebP | 5 MB (reject if larger) |
| video | 50 MB |
| generic file | 100 MB |

### Auth resolution (CLI)

1. `CLI_TOOLS_TOKEN` env (wins)
2. else config file token
3. else error → run `auth set`

### Config

- Path: `$XDG_CONFIG_HOME/cli-tools/config` or `~/.config/cli-tools/config`
- Format: **JSON**
- Example:

```json
{
  "token": "..."
}
```

### Base URL

- Hardcoded default: `https://cli-tools.cpzhmlb.uk`
- Optional override: env `CLI_TOOLS_BASE_URL` only

## Worker (Cloudflare)

- **Runtime:** TypeScript + Wrangler
- **Dir:** `worker/`
- **R2 bucket:** `cli-tools`, binding name `BUCKET`
- **Secret:** `UPLOAD_TOKEN` via `wrangler secret put UPLOAD_TOKEN`

### Routes

| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| `POST` | `/v1/upload` | `Authorization: Bearer <token>` | Store object; return JSON |
| `GET` | `/YYYY-MM-DD/<uuid>` | none | Serve bytes or 404 if missing/expired |

No CORS (CLI only). No list/delete APIs.

### Upload request

- Headers:
  - `Authorization: Bearer <token>` (required)
  - `Content-Type: text/html; charset=utf-8` \| image/video types \| `application/octet-stream` for generic files
  - TTL query: `?ttl=7d` (default `7d`; `application/octet-stream` defaults to `24h`; max `30d`)
- Body: raw bytes; generic uploads require `Content-Length`
- Worker generates id (`YYYY-MM-DD` UTC + UUID v4)
- Worker enforces per-type size caps; generic uploads stream into R2; TTL max is 30d

### Upload response `200`

```json
{
  "url": "https://cli-tools.cpzhmlb.uk/2026-07-17/<uuid>",
  "expires_at": "2026-07-24T12:00:00.000Z"
}
```

Errors: `401` bad/missing token; `400` bad ttl/type/size; `413` too large. CLI maps to one-line stderr.

### R2 object

- Key: `YYYY-MM-DD/<uuid>`
- HTTP Content-Type: as uploaded
- Custom metadata: `expires-at` = unix seconds (string); generic file `download-filename` = sanitized original basename

### GET response headers

**HTML**

- `Content-Type: text/html; charset=utf-8`
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline`

**Image / video**

- Stored `Content-Type`
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: inline`

**Generic file**

- `Content-Type: application/octet-stream`
- `X-Content-Type-Options: nosniff`
- `Content-Disposition: attachment` with the original basename and extension (`filename` + UTF-8 `filename*`)

No CSP v1.

### TTL / cleanup

1. Default TTL 7d (24h for generic files); per-request override; max 30d
2. On GET: if `now > expires-at` → **404** and best-effort **delete** object
3. R2 lifecycle backstop: delete objects older than **31 days**
4. No D1/KV index; no cron lister in v1

## Repo layout (target)

```
cli-tools/                 # Go module root
  DESIGN.md
  go.mod
  cmd/cli-tools/main.go    # or equivalent minimal package layout
  internal/...             # only if needed
  worker/
    package.json
    wrangler.toml
    src/index.ts
```

Keep packages flat; no extra abstraction layers.

## Implementation order (when building)

1. Worker: auth, upload, get, expiry metadata, size/ttl checks
2. R2 bucket + secret + custom domain `cli-tools.cpzhmlb.uk`
3. Go CLI: auth config, plan, image+webp, flags
4. Manual smoke: plan HTML + png → open URLs → wait/expire check

## Open at implement time (not product decisions)

- Exact TTL header vs query param (prefer `?ttl=`)
- Go WebP library choice (prefer pure Go / easy module)
- wrangler account/zone wiring for `cpzhmlb.uk`
- Whether `auth set` reads token from stdin when not passed as arg

## Locked decisions log

| # | Decision |
|---|----------|
| 1 | Single tenant: only you |
| 2 | Public GET; unguessable id |
| 3 | Path = date prefix + uuid |
| 4 | Default TTL 7d |
| 5 | `--ttl`, max 30d, no forever |
| 6 | Image → WebP q80; png/jpg/webp; no resize; no gif |
| 7 | Plan: local html/htm only, as-is |
| 8 | Auth: env > JSON config; `auth set\|status\|clear` |
| 9 | Host `cli-tools.cpzhmlb.uk` |
| 10 | Size: plan 2MB; image 10MB in / 5MB out |
| 11 | Monorepo |
| 12 | Go CLI, binary `cli-tools` |
| 13 | One POST upload API; CLI distinguishes plan/image |
| 14 | Lazy delete on expired GET + 31d lifecycle |
| 15 | No list/delete v1 |
| 16 | Errors: one-line stderr, empty stdout |
| 17 | nosniff + inline; no CSP |
| 18 | CLI only; no CORS |
| 19 | Base URL hardcoded; `CLI_TOOLS_BASE_URL` override |
| 20 | Worker secret `UPLOAD_TOKEN` |
| 21 | Config JSON |
| 22 | Worker assigns ids |
| 23 | R2 bucket `cli-tools`, binding `BUCKET` |
| 24 | Flags: plan `--ttl`; image `--ttl --quality --no-compress` |
| 25 | Install: go install; releases later |
| 26 | Worker: TypeScript + Wrangler |
| 27 | `POST /v1/upload` |
| 28 | Metadata: expires-at + content-type |
