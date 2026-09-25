# cli-tools worker

Cloudflare Worker + R2: authenticated upload, public GET with TTL.

## Setup

```bash
# create bucket (once)
npx wrangler r2 bucket create cli-tools

# secret
npx wrangler secret put UPLOAD_TOKEN

# deploy
npm install
npm run deploy
```

### Custom domain

In Cloudflare dashboard → Workers → `cli-tools` → Settings → Domains & Routes:
add `cli-tools.cpzhmlb.uk` (zone must be on the same account).

### R2 lifecycle (31d backstop)

Dashboard → R2 → `cli-tools` → Settings → Object lifecycle rules:
add rule delete objects after **31 days**. (Not set via wrangler.toml easily; dashboard is fine.)

## API

- `POST /v1/upload?ttl=7d` — `Authorization: Bearer <token>`, raw body, `Content-Type` one of:
  `text/html`, `text/html; charset=utf-8`, `image/webp`, `image/png`, `image/jpeg`, `image/jpg`, `video/mp4`, `video/webm`, `video/quicktime`, `application/octet-stream` (optional `X-Download-Filename` header: unpadded base64url UTF-8 basename)
  - HTML max 2MB; images max 10MB; videos max 50MB; generic files max 100MB
  - default TTL `7d` (generic files default to `24h`), max `30d` (`Nh` / `Nd`)
  - generic files require `Content-Length` for streaming into R2 and download with their original filename/extension (`Content-Disposition: attachment`)
  - `200` `{ "url", "expires_at" }`
- `GET /YYYY-MM-DD/<uuid>` — public; expired → 404 + best-effort delete

## Local

```bash
npm test
npm run dev   # needs local R2 / remote binding
```
