import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePoints, encodePoints, quantizePoints } from "../src/core/codec.ts";
import { line } from "./helpers.ts";

describe("codec", () => {
  it("round-trips quantised pressure points exactly", () => {
    const pts = quantizePoints([0, 0, 0.5, 12.34, -5.67, 0.81, 1e5, -1e5, 1, -0.05, 0.05, 0]);
    assert.deepEqual(decodePoints(encodePoints(pts)), pts);
  });

  it("round-trips laser timing in whole milliseconds", () => {
    const pts = quantizePoints([0, 0, 0, 5, 5, 16.4, 9, 9, 1200.6], "time");
    assert.deepEqual(
      pts.filter((_, i) => i % 3 === 2),
      [0, 16, 1201],
    );
    assert.deepEqual(decodePoints(encodePoints(pts, "time"), "time"), pts);
  });

  it("is much smaller than JSON", () => {
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push(1234.5 + i * 0.7, 876.5 + Math.sin(i / 9) * 40, 0.4 + (i % 50) / 100);
    const q = quantizePoints(pts);
    const encoded = encodePoints(q);
    assert.ok(encoded.length * 3 < JSON.stringify(q).length, `${encoded.length} vs ${JSON.stringify(q).length}`);
    assert.ok(encoded.length / 500 <= 6, `${encoded.length / 500} characters per point`);
  });

  it("handles an empty point list", () => {
    assert.deepEqual(decodePoints(encodePoints([])), []);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [null, 42, "", "2AAAA", "1!!!", "1/w==", {}, "1" + "/".repeat(9)]) {
      assert.equal(decodePoints(bad), null, String(bad));
    }
  });

  it("rejects truncated varints", () => {
    const enc = encodePoints([1000, 1000, 0.5]);
    const bytes = Buffer.from(enc.slice(1), "base64");
    const cut = "1" + Buffer.from(bytes.subarray(0, bytes.length - 1)).toString("base64");
    assert.equal(decodePoints(cut), null);
  });

  it("stops at maxPoints", () => {
    const enc = encodePoints(line(100));
    assert.equal(decodePoints(enc, "pressure", 10)!.length, 30);
  });

  it("clamps absurd coordinates instead of overflowing", () => {
    const out = decodePoints(encodePoints([1e12, -1e12, 0.5]))!;
    assert.ok(Number.isFinite(out[0]!) && Number.isFinite(out[1]!));
  });
});
