/** TTL → seconds. Default 7d, max 30d. Accepts Nh / Nd. */
export function parseTtl(raw: string | null): { ok: true; seconds: number } | { ok: false; error: string } {
  const s = (raw ?? "7d").trim().toLowerCase();
  const m = /^(\d+)([hd])$/.exec(s);
  if (!m) return { ok: false, error: "ttl must be Nh or Nd" };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return { ok: false, error: "ttl must be positive" };
  const seconds = m[2] === "h" ? n * 3600 : n * 86400;
  const max = 30 * 86400;
  if (seconds > max) return { ok: false, error: "ttl max is 30d" };
  return { ok: true, seconds };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate object key path YYYY-MM-DD/<uuid-v4> (no leading slash). */
export function isObjectPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.length !== 2) return false;
  const [date, id] = parts;
  return DATE_RE.test(date) && UUID_RE.test(id);
}

export const ALLOWED_TYPES = new Set([
  "text/html",
  "text/html; charset=utf-8",
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export function maxBytesFor(contentType: string): number | null {
  const ct = contentType.toLowerCase().trim();
  if (ct.startsWith("text/html")) return 2 * 1024 * 1024;
  // image input / --no-compress originals: 10MB (CLI still caps post-WebP at 5MB)
  if (ct.startsWith("image/")) return 10 * 1024 * 1024;
  // video: raw only, no Stream/transcode — R2 storage only
  if (ct.startsWith("video/")) return 50 * 1024 * 1024;
  return null;
}

export function utcDatePrefix(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
