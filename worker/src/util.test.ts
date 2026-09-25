import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_TYPES,
  contentDispositionFor,
  decodeDownloadFilename,
  downloadContentDisposition,
  parseTtl,
  isObjectPath,
  maxBytesFor,
  sanitizeDownloadFilename,
  utcDatePrefix,
} from "./util.ts";

describe("parseTtl", () => {
  it("defaults to 7d for specialized types and 24h for generic uploads", () => {
    assert.deepEqual(parseTtl(null), { ok: true, seconds: 7 * 86400 });
    assert.deepEqual(parseTtl(null, "image/png"), { ok: true, seconds: 7 * 86400 });
    assert.deepEqual(parseTtl(null, "application/octet-stream"), { ok: true, seconds: 24 * 3600 });
    assert.deepEqual(parseTtl("30d", "application/octet-stream"), { ok: true, seconds: 30 * 86400 });
    assert.equal(parseTtl("31d", "application/octet-stream").ok, false);
  });
  it("parses hours and days", () => {
    assert.deepEqual(parseTtl("1h"), { ok: true, seconds: 3600 });
    assert.deepEqual(parseTtl("7d"), { ok: true, seconds: 7 * 86400 });
    assert.deepEqual(parseTtl("30d"), { ok: true, seconds: 30 * 86400 });
  });
  it("rejects bad / over max", () => {
    assert.equal(parseTtl("forever").ok, false);
    assert.equal(parseTtl("0d").ok, false);
    assert.equal(parseTtl("31d").ok, false);
    assert.equal(parseTtl("721h").ok, false);
  });
  it("allows 720h (30d)", () => {
    assert.deepEqual(parseTtl("720h"), { ok: true, seconds: 30 * 86400 });
  });
});

describe("isObjectPath", () => {
  it("accepts date/uuid-v4", () => {
    assert.equal(isObjectPath("2026-07-17/550e8400-e29b-41d4-a716-446655440000"), true);
  });
  it("rejects junk", () => {
    assert.equal(isObjectPath("foo"), false);
    assert.equal(isObjectPath("2026-07-17/not-a-uuid"), false);
    assert.equal(isObjectPath("2026-7-17/550e8400-e29b-41d4-a716-446655440000"), false);
    assert.equal(isObjectPath("/2026-07-17/550e8400-e29b-41d4-a716-446655440000"), false);
  });
});

describe("maxBytesFor", () => {
  it("allows generic uploads and keeps specialized caps", () => {
    assert.equal(ALLOWED_TYPES.has("application/octet-stream"), true);
    assert.equal(maxBytesFor("text/html; charset=utf-8"), 2 * 1024 * 1024);
    assert.equal(maxBytesFor("image/webp"), 10 * 1024 * 1024);
    assert.equal(maxBytesFor("image/png"), 10 * 1024 * 1024);
    assert.equal(maxBytesFor("video/mp4"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("video/webm"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("video/quicktime"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("application/octet-stream"), 100 * 1024 * 1024);
    assert.equal(maxBytesFor("application/pdf"), null);
  });
});

describe("contentDispositionFor", () => {
  it("renders recognized specialized types inline and generic/unknown types as attachments", () => {
    assert.equal(contentDispositionFor("text/html; charset=utf-8"), "inline");
    assert.equal(contentDispositionFor("image/png"), "inline");
    assert.equal(contentDispositionFor("application/octet-stream"), "attachment");
    assert.equal(contentDispositionFor("application/x-dangerous"), "attachment");
  });
});

describe("download filename", () => {
  it("decodes an unpadded base64url UTF-8 basename and strips both path styles", () => {
    const encoded = Buffer.from("C:\\Users\\Ada\\résumé final.pdf", "utf8")
      .toString("base64url");
    assert.equal(decodeDownloadFilename(encoded), "résumé final.pdf");
  });

  it("removes controls and quotes, rejects malformed input, and caps length", () => {
    assert.equal(sanitizeDownloadFilename("../bad\"name\r\n.pdf"), "badname.pdf");
    assert.equal(decodeDownloadFilename("%%%"), null);
    assert.equal(decodeDownloadFilename("_"), null);
    assert.ok(Buffer.byteLength(sanitizeDownloadFilename(`${"é".repeat(300)}.txt`)!) <= 255);
  });

  it("builds quoted ASCII fallback and RFC 5987 UTF-8 filename headers", () => {
    assert.equal(
      downloadContentDisposition("résumé \"final\".pdf"),
      "attachment; filename=\"r_sum_ _final_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf",
    );
  });
});

describe("utcDatePrefix", () => {
  it("YYYY-MM-DD", () => {
    assert.match(utcDatePrefix(new Date("2026-07-17T23:00:00Z")), /^2026-07-17$/);
  });
});
