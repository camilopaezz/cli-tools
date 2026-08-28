import {
  ALLOWED_TYPES,
  isObjectPath,
  maxBytesFor,
  parseTtl,
  utcDatePrefix,
} from "./util";

export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN: string;
  PUBLIC_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    if (request.method === "POST" && path === "v1/upload") {
      return handleUpload(request, env, url);
    }

    if (request.method === "GET" && isObjectPath(path)) {
      return handleGet(path, env, request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handleUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tokenMatches(token, env.UPLOAD_TOKEN ?? "")) {
    return json({ error: "unauthorized" }, 401);
  }

  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase().trim();
  if (!ALLOWED_TYPES.has(contentType)) {
    return json({ error: "unsupported content-type" }, 400);
  }

  const ttl = parseTtl(url.searchParams.get("ttl"));
  if (!ttl.ok) return json({ error: ttl.error }, 400);

  const max = maxBytesFor(contentType)!;
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json({ error: "empty body" }, 400);
  if (body.byteLength > max) return json({ error: "payload too large" }, 413);

  const key = `${utcDatePrefix()}/${crypto.randomUUID()}`;
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttl.seconds;

  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { "expires-at": String(expiresAtSec) },
  });

  const base = (env.PUBLIC_BASE_URL || "https://cli-tools.cpzhmlb.uk").replace(/\/$/, "");
  return json(
    {
      url: `${base}/${key}`,
      expires_at: new Date(expiresAtSec * 1000).toISOString(),
    },
    200,
  );
}

/** Parse single `bytes=` range. Returns null if unsatisfiable/malformed. */
function parseBytesRange(header: string, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || size <= 0) return null;
  const startS = m[1];
  const endS = m[2];
  if (startS === "" && endS === "") return null;
  if (startS === "") {
    const suffix = Number(endS);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(Math.floor(suffix), size);
    return { offset: size - length, length };
  }
  const start = Number(startS);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;
  const end = endS === "" ? size - 1 : Math.min(Number(endS), size - 1);
  if (!Number.isFinite(end) || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

async function handleGet(key: string, env: Env, request: Request): Promise<Response> {
  const rangeHeader = request.headers.get("Range");
  // Parse against size via head when ranging — avoids trusting obj.range shape (was NaN).
  let bounds: { offset: number; length: number } | null = null;
  if (rangeHeader) {
    const meta = await env.BUCKET.head(key);
    if (!meta) return new Response("Not Found", { status: 404 });
    const exp = meta.customMetadata?.["expires-at"];
    if (exp && Number(exp) < Math.floor(Date.now() / 1000)) {
      await env.BUCKET.delete(key);
      return new Response("Not Found", { status: 404 });
    }
    bounds = parseBytesRange(rangeHeader, meta.size);
    if (!bounds) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${meta.size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
  }

  const obj = await env.BUCKET.get(
    key,
    bounds ? { range: { offset: bounds.offset, length: bounds.length } } : undefined,
  );
  if (!obj) return new Response("Not Found", { status: 404 });

  const exp = obj.customMetadata?.["expires-at"];
  if (exp && Number(exp) < Math.floor(Date.now() / 1000)) {
    // must complete before isolate freezes on 404 return
    await env.BUCKET.delete(key);
    return new Response("Not Found", { status: 404 });
  }

  const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  if (bounds) {
    headers.set(
      "Content-Range",
      `bytes ${bounds.offset}-${bounds.offset + bounds.length - 1}/${obj.size}`,
    );
    headers.set("Content-Length", String(bounds.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
