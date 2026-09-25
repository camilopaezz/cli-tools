/** TTL → seconds. Defaults to 7d, or 24h for generic uploads; max 30d. Accepts Nh / Nd. */
export function parseTtl(
  raw: string | null,
  contentType?: string,
): { ok: true; seconds: number } | { ok: false; error: string } {
  const defaultTtl = contentType?.toLowerCase().trim() === "application/octet-stream" ? "24h" : "7d";
  const s = (raw ?? defaultTtl).trim().toLowerCase();
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
  "application/octet-stream",
]);

export function maxBytesFor(contentType: string): number | null {
  const ct = contentType.toLowerCase().trim();
  if (ct === "application/octet-stream") return 100 * 1024 * 1024;
  if (ct.startsWith("text/html")) return 2 * 1024 * 1024;
  // image input / --no-compress originals: 10MB (CLI still caps post-WebP at 5MB)
  if (ct.startsWith("image/")) return 10 * 1024 * 1024;
  // video: raw only, no Stream/transcode — R2 storage only
  if (ct.startsWith("video/")) return 50 * 1024 * 1024;
  return null;
}

/** Only recognized specialized types may be rendered inline; unknown stored types are attachments. */
export function contentDispositionFor(contentType: string): "inline" | "attachment" {
  const ct = contentType.toLowerCase().trim();
  return ALLOWED_TYPES.has(ct) && ct !== "application/octet-stream" ? "inline" : "attachment";
}

const MAX_FILENAME_BYTES = 255;

/** Decode an optional unpadded base64url UTF-8 filename and make it a safe basename. */
export function decodeDownloadFilename(header: string | null): string | null {
  if (!header || !/^[A-Za-z0-9_-]+$/.test(header) || header.length % 4 === 1) return null;
  try {
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return sanitizeDownloadFilename(decoded);
  } catch {
    return null;
  }
}

/** Keep only a safe basename and cap its UTF-8 length without losing its extension. */
export function sanitizeDownloadFilename(input: string): string | null {
  let name = input.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/[\\"]/g, "").trim();
  if (!name || name === "." || name === "..") return null;

  const dot = name.lastIndexOf(".");
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : "";
  const encoder = new TextEncoder();
  while (encoder.encode(ext).length > 32) ext = Array.from(ext).slice(0, -1).join("");
  let available = MAX_FILENAME_BYTES - encoder.encode(ext).length;
  stem = Array.from(stem).reduce((out, char) => {
    const size = encoder.encode(char).length;
    if (size > available) return out;
    available -= size;
    return out + char;
  }, "");
  name = stem + ext;
  return name && name !== "." ? name : null;
}

/** Build a safe disposition value for a generic download filename. */
export function downloadContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function utcDatePrefix(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
