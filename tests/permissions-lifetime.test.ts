import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FADE_PRESETS,
  formatLifetime,
  goneAt,
  isGone,
  lifeAlpha,
  lifeState,
  parseLifetime,
} from "../src/core/lifetime.ts";
import { DEFAULT_THRESHOLDS, ROLES, allowed, mayModify } from "../src/core/permissions.ts";
import { ALICE, BOB } from "./helpers.ts";

describe("permissions", () => {
  it("applies the default role thresholds", () => {
    assert.ok(allowed(ROLES.PLAYER, "screen", DEFAULT_THRESHOLDS));
    assert.ok(allowed(ROLES.PLAYER, "map", DEFAULT_THRESHOLDS));
    assert.ok(!allowed(ROLES.PLAYER, "permanent", DEFAULT_THRESHOLDS));
    assert.ok(allowed(ROLES.TRUSTED, "permanent", DEFAULT_THRESHOLDS));
    assert.ok(!allowed(ROLES.TRUSTED, "manage", DEFAULT_THRESHOLDS));
    assert.ok(allowed(ROLES.ASSISTANT, "manage", DEFAULT_THRESHOLDS));
  });

  it("always allows the GM and never allows role NONE", () => {
    const strict = { screen: 99, map: 99, permanent: 99, manage: 99, media: 99 };
    assert.ok(allowed(ROLES.GAMEMASTER, "manage", strict));
    const lax = { screen: 0, map: 0, permanent: 0, manage: 0, media: 0 };
    assert.ok(!allowed(ROLES.NONE, "screen", lax));
  });

  it("lets authors modify their own items only, unless they may manage", () => {
    assert.ok(mayModify(ALICE, ROLES.PLAYER, ALICE, DEFAULT_THRESHOLDS));
    assert.ok(!mayModify(ALICE, ROLES.PLAYER, BOB, DEFAULT_THRESHOLDS));
    assert.ok(mayModify(ALICE, ROLES.ASSISTANT, BOB, DEFAULT_THRESHOLDS));
  });
});

describe("lifetime", () => {
  const item = { expiresAt: 10_000, fadeDuration: 1000 };

  it("goes visible → fading → gone on absolute server time", () => {
    assert.equal(lifeState(item, 9_999), "visible");
    assert.equal(lifeState(item, 10_500), "fading");
    assert.equal(lifeState(item, 11_000), "gone");
    assert.equal(goneAt(item), 11_000);
    assert.ok(isGone(item, 11_000));
  });

  it("fades alpha monotonically from 1 to 0", () => {
    let last = 1;
    for (let t = 10_000; t <= 11_000; t += 50) {
      const a = lifeAlpha(item, t);
      assert.ok(a <= last + 1e-12 && a >= 0);
      last = a;
    }
    assert.equal(lifeAlpha(item, 10_000), 1);
    assert.equal(lifeAlpha(item, 11_000), 0);
    assert.equal(lifeAlpha({ expiresAt: 10, fadeDuration: 0 }, 10), 0);
  });

  it("treats permanent items as never gone", () => {
    const p = { expiresAt: null, fadeDuration: 500 };
    assert.equal(lifeState(p, 1e15), "visible");
    assert.equal(goneAt(p), Infinity);
  });

  it("formats and parses lifetimes", () => {
    assert.equal(formatLifetime(0), "∞");
    assert.equal(formatLifetime(2000), "2s");
    assert.equal(formatLifetime(1500), "1.5s");
    assert.equal(formatLifetime(60_000), "1m");
    assert.equal(formatLifetime(90_000), "1m30s");
    assert.equal(parseLifetime("15s"), 15_000);
    assert.equal(parseLifetime("2m"), 120_000);
    assert.equal(parseLifetime("1m30s"), 90_000);
    assert.equal(parseLifetime(" 90 "), 90_000);
    assert.equal(parseLifetime("∞"), 0);
    for (const bad of ["", "abc", "-5s", "5h", "m"]) assert.equal(parseLifetime(bad), null, bad);
    for (const ms of [2000, 1500, 60_000, 90_000]) assert.equal(parseLifetime(formatLifetime(ms)), ms);
    assert.ok(FADE_PRESETS.includes(0));
  });
});
