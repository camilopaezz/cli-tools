import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTtl, isObjectPath, maxBytesFor, utcDatePrefix } from "./util.ts";

describe("parseTtl", () => {
  it("defaults to 7d", () => {
    assert.equal(parseTtl(null).ok && (parseTtl(null) as { seconds: number }).seconds, 7 * 86400);
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
  it("html 2MB image 10MB video 50MB", () => {
    assert.equal(maxBytesFor("text/html; charset=utf-8"), 2 * 1024 * 1024);
    assert.equal(maxBytesFor("image/webp"), 10 * 1024 * 1024);
    assert.equal(maxBytesFor("image/png"), 10 * 1024 * 1024);
    assert.equal(maxBytesFor("video/mp4"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("video/webm"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("video/quicktime"), 50 * 1024 * 1024);
    assert.equal(maxBytesFor("application/pdf"), null);
  });
});

describe("utcDatePrefix", () => {
  it("YYYY-MM-DD", () => {
    assert.match(utcDatePrefix(new Date("2026-07-17T23:00:00Z")), /^2026-07-17$/);
  });
});
