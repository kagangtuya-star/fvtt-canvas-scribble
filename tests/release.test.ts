import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "kagangtuya-star/fvtt-canvas-scribble";
const URL = `https://github.com/${REPO}`;
let root: string;

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(root, "tools", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MODULE_REPO: "", RELEASE_TAG: "", ...env },
  });
  assert.ifError(result.error);
  return result;
}

function ok(script: string, args: string[] = [], env: Record<string, string> = {}): void {
  const result = run(script, args, env);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function zippedManifest(): Record<string, any> {
  const zip = readFileSync(join(root, "release/module.zip"));
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    if (name === "module.json") {
      const data = zip.subarray(start, start + size);
      return JSON.parse((method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    }
    offset = start + size;
  }
  assert.fail("module.json missing from release/module.zip");
}

describe("release build and packaging", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "canvas-scribble-release-"));
    cpSync(join(ROOT, "tools"), join(root, "tools"), { recursive: true });
    // Use the installed runtime dependencies; no network or dependency installation.
    for (const dep of ["perfect-freehand", "simplex-noise", "lazy-brush", "roughjs"]) {
      cpSync(join(ROOT, "node_modules", dep), join(root, "node_modules", dep), {
        recursive: true,
      });
    }
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/main.ts"), "export const ready: boolean = true;\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
    writeFileSync(
      join(root, "module.json"),
      JSON.stringify({
        id: "canvas-scribble",
        title: "Release test",
        authors: [{ name: "Test" }],
        compatibility: { minimum: "13" },
        esmodules: ["scripts/main.js"],
        socket: true,
      }),
    );
    for (const dir of ["lang", "styles"]) mkdirSync(join(root, dir));
    for (const file of ["LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"]) {
      writeFileSync(join(root, file), "Test fixture\n");
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const tag of ["v1.0.1", "2.0.0", "v2.1.0-beta.1+build.2"]) {
    it(`derives all release manifests from ${tag} without changing source versions`, () => {
      const source = readFileSync(join(root, "module.json"), "utf8");
      const env = { MODULE_REPO: REPO, RELEASE_TAG: tag };
      ok("build.mjs", [], env);
      ok("validate-manifest.mjs");
      ok("package.mjs", [], env);
      const manifest = json("release/module.json");
      assert.equal(manifest.version, tag.replace(/^v/, ""));
      assert.equal(manifest.url, URL);
      assert.equal(manifest.manifest, `${URL}/releases/latest/download/module.json`);
      assert.equal(manifest.download, `${URL}/releases/download/${encodeURIComponent(tag)}/module.zip`);
      assert.equal(manifest.bugs, `${URL}/issues`);
      assert.deepEqual(json("dist/module.json"), manifest);
      assert.deepEqual(zippedManifest(), manifest);
      assert.equal(readFileSync(join(root, "module.json"), "utf8"), source);
      assert.equal(json("package.json").version, "1.0.0");
    });
  }

  it("uses package.json for local builds without release URLs", () => {
    ok("build.mjs");
    ok("package.mjs");
    const manifest = json("release/module.json");
    assert.equal(manifest.version, "1.0.0");
    for (const key of ["url", "manifest", "download", "bugs"]) assert.equal(manifest[key], undefined);
    assert.deepEqual(zippedManifest(), manifest);
  });

  it("releases despite a stale version in an older source manifest", () => {
    const manifest = { ...json("module.json"), version: "1.0.1" };
    writeFileSync(join(root, "module.json"), JSON.stringify(manifest));
    const env = { MODULE_REPO: REPO, RELEASE_TAG: "v1.0.2" };
    ok("build.mjs", [], env);
    ok("package.mjs", [], env);
    assert.equal(zippedManifest().version, "1.0.2");
    assert.equal(json("module.json").version, "1.0.1");
    assert.equal(json("package.json").version, "1.0.0");
  });

  it("lets explicit packaging arguments override the built version and environment", () => {
    ok("build.mjs");
    ok("package.mjs", ["--repo", REPO, "--tag", "v3.2.1"], { RELEASE_TAG: "v9.9.9", MODULE_REPO: "other/repo" });
    assert.equal(json("release/module.json").version, "3.2.1");
    assert.equal(json("release/module.json").download, `${URL}/releases/download/v3.2.1/module.zip`);
    assert.deepEqual(zippedManifest(), json("dist/module.json"));
  });

  it("rejects invalid tags before creating build or release output", () => {
    for (const tag of ["v1.0", "v01.0.0", "v1.0.0-01", "vv1.0.0", "../bad"]) {
      const result = run("build.mjs", [], { MODULE_REPO: REPO, RELEASE_TAG: tag });
      assert.notEqual(result.status, 0, tag);
      assert.match(result.stderr, /Invalid release tag/);
      assert.equal(existsSync(join(root, "dist")), false);
    }
    ok("build.mjs");
    const before = readFileSync(join(root, "dist/module.json"), "utf8");
    const result = run("package.mjs", ["--repo", REPO, "--tag", "v1.0"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid release tag/);
    assert.equal(readFileSync(join(root, "dist/module.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "release")), false);
  });

  it("rejects invalid repository names", () => {
    const result = run("build.mjs", [], { MODULE_REPO: "owner/repo/extra", RELEASE_TAG: "v1.0.1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid repository/);
    assert.equal(existsSync(join(root, "dist")), false);
  });
});
