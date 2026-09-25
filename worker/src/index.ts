import {
  ALLOWED_TYPES,
  contentDispositionFor,
  decodeDownloadFilename,
  downloadContentDisposition,
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

  const ttl = parseTtl(url.searchParams.get("ttl"), contentType);
  if (!ttl.ok) return json({ error: ttl.error }, 400);

  const max = maxBytesFor(contentType)!;
  const isGeneric = contentType === "application/octet-stream";
  const contentLengthHeader = request.headers.get("Content-Length");
  let contentLength: number | null = null;
  if (isGeneric) {
    if (contentLengthHeader === null) {
      return json({ error: "content-length required for application/octet-stream" }, 411);
    }
    if (!/^\d+$/.test(contentLengthHeader)) {
      return json({ error: "invalid content-length" }, 400);
    }
    contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) return json({ error: "invalid content-length" }, 400);
    if (contentLength === 0) return json({ error: "empty body" }, 400);
  } else if (contentLengthHeader && /^\d+$/.test(contentLengthHeader) && Number(contentLengthHeader) > max) {
    return json({ error: "payload too large" }, 413);
  }
  if (contentLength !== null && contentLength > max) {
    return json({ error: "payload too large" }, 413);
  }
  if (!request.body) return json({ error: "empty body" }, 400);

  const key = `${utcDatePrefix()}/${crypto.randomUUID()}`;
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttl.seconds;
  const downloadFilename = isGeneric
    ? decodeDownloadFilename(request.headers.get("X-Download-Filename"))
    : null;
  const customMetadata: Record<string, string> = { "expires-at": String(expiresAtSec) };
  if (downloadFilename) customMetadata["download-filename"] = downloadFilename;
  const putOptions = {
    httpMetadata: { contentType },
    customMetadata,
  };

  if (isGeneric) {
    // R2 requires a known stream length. FixedLengthStream supplies it while the transform
    // independently verifies the actual byte count before forwarding each chunk.
    const fixedLength = new FixedLengthStream(contentLength!);
    let received = 0;
    let tooLarge = false;
    let empty = false;
    let lengthMismatch = false;
    const countedBody = request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > max) {
            tooLarge = true;
            controller.error(new Error("payload too large"));
            return;
          }
          if (received > contentLength!) {
            lengthMismatch = true;
            controller.error(new Error("content-length mismatch"));
            return;
          }
          if (chunk.byteLength > 0) controller.enqueue(chunk);
        },
        flush() {
          if (received === 0) {
            empty = true;
            throw new Error("empty body");
          }
          if (received !== contentLength) {
            lengthMismatch = true;
            throw new Error("content-length mismatch");
          }
        },
      }),
    );

    try {
      const [putResult, streamResult] = await Promise.allSettled([
        env.BUCKET.put(key, fixedLength.readable, putOptions),
        countedBody.pipeTo(fixedLength.writable),
      ]);
      if (putResult.status === "rejected") throw putResult.reason;
      if (streamResult.status === "rejected") throw streamResult.reason;
    } catch (error) {
      if (tooLarge) return json({ error: "payload too large" }, 413);
      if (empty) return json({ error: "empty body" }, 400);
      if (lengthMismatch) return json({ error: "content-length mismatch" }, 400);
      throw error;
    }
  } else {
    // Existing specialized uploads stay buffered; their established limits are at most 50 MiB.
    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return json({ error: "empty body" }, 400);
    if (body.byteLength > max) return json({ error: "payload too large" }, 413);
    await env.BUCKET.put(key, body, putOptions);
  }

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
  const downloadFilename =
    contentType.toLowerCase().trim() === "application/octet-stream"
      ? obj.customMetadata?.["download-filename"]
      : undefined;
  const headers = new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": downloadFilename
      ? downloadContentDisposition(downloadFilename)
      : contentDispositionFor(contentType),
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
