#!/usr/bin/env node
/**
 * Zero-dependency build: strips TypeScript types with Node's built-in
 * `module.stripTypeScriptTypes` (Node ≥ 22.13), rewrites import specifiers and
 * assembles an installable module folder in `dist/`.
 *
 * Foundry loads native ES modules, so no bundler is needed: each source file
 * maps 1:1 to an output file (readable stack traces, no source maps required).
 *
 *   node tools/build.mjs            production build into dist/
 *   node tools/build.mjs --watch    rebuild on change
 *   node tools/build.mjs --harness  also build dev/ harness into dist-dev/
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configureManifest } from "./release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const OUT_SCRIPTS = join(DIST, "scripts");
const VENDOR_ROOT = join(OUT_SCRIPTS, "vendor");
const args = new Set(process.argv.slice(2));

/** Static files copied into the package root. */
const STATIC = ["lang", "styles", "LICENSE", "README.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md"];

/**
 * Runtime ESM dependencies vendored into `dist/scripts/vendor/<pkg>/`.
 * Each entry maps an import specifier used in `src/` to an npm package and
 * optional explicit single-file ESM entry.
 */
const VENDORS = [
  { spec: "perfect-freehand", pkg: "perfect-freehand", dir: "perfect-freehand" },
  { spec: "simplex-noise", pkg: "simplex-noise", dir: "simplex-noise" },
  { spec: "lazy-brush", pkg: "lazy-brush", dir: "lazy-brush" },
  { spec: "roughjs/bundled/rough.esm.js", pkg: "roughjs", dir: "roughjs", explicitEntry: "bundled/rough.esm.js" },
];

const log = (...m) => console.log("[build]", ...m);

function walk(dir, filter) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

/** Locate a package's ESM entry through Node resolution (honours package "exports"). */
function resolveVendor(v) {
  const req = createRequire(join(ROOT, "package.json"));
  const pkgJsonPath = (req.resolve.paths(v.pkg) ?? [])
    .map((dir) => join(dir, v.pkg, "package.json"))
    .find((p) => existsSync(p));
  if (!pkgJsonPath) throw new Error(`${v.pkg} is not installed. Run \`npm install\` (see README → Development).`);
  const pkgDir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (v.explicitEntry) {
    const file = join(pkgDir, v.explicitEntry);
    if (existsSync(file)) return { pkgDir, entry: file, version: pkg.version, singleFile: true };
    throw new Error(`Missing ${v.explicitEntry} in ${v.pkg}@${pkg.version}`);
  }
  const exp = pkg.exports?.["."] ?? pkg.exports;
  const candidates = [
    typeof exp === "string" ? exp : null,
    exp?.import?.default ?? exp?.import,
    exp?.module,
    exp?.default,
    pkg.module,
  ].filter((c) => typeof c === "string");
  for (const c of candidates) {
    const file = join(pkgDir, c);
    if (existsSync(file)) return { pkgDir, entry: file, version: pkg.version, singleFile: false };
  }
  throw new Error(`Could not find an ES module entry in ${v.pkg}@${pkg.version}`);
}

function vendorAll(vendorRoot = VENDOR_ROOT) {
  const entries = new Map();
  for (const v of VENDORS) {
    const { pkgDir, entry, version, singleFile } = resolveVendor(v);
    const vendorDir = join(vendorRoot, v.dir);
    mkdirSync(vendorDir, { recursive: true });
    let outEntry;
    if (singleFile) {
      outEntry = join(vendorDir, basename(entry));
      cpSync(entry, outEntry);
    } else {
      const entryDir = dirname(entry);
      for (const file of walk(entryDir, (p) => /\.(m?js)$/.test(p) && !/\.map$/.test(p))) {
        const target = join(vendorDir, relative(entryDir, file));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(file, target);
      }
      outEntry = join(vendorDir, relative(entryDir, entry));
    }
    for (const lic of ["LICENSE", "LICENSE.md", "license"]) {
      if (existsSync(join(pkgDir, lic))) cpSync(join(pkgDir, lic), join(vendorDir, "LICENSE"));
    }
    if (!existsSync(join(vendorDir, "LICENSE"))) {
      throw new Error(`${v.pkg} LICENSE not found; refusing to ship it without its license text.`);
    }
    log(`vendored ${v.pkg}@${version}`);
    entries.set(v.spec, outEntry);
  }
  return entries;
}

const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s*\*\s*from\s*)(["'])([^"'\n]+)\2/g;

function rewriteSpecifiers(code, outFile, vendorEntries) {
  return code.replace(SPECIFIER_RE, (all, lead, q, spec) => {
    const vendored = vendorEntries.get(spec);
    if (vendored) {
      let rel = relative(dirname(outFile), vendored).split(sep).join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${lead}${q}${rel}${q}`;
    }
    if (spec.startsWith(".") && spec.endsWith(".ts")) return `${lead}${q}${spec.slice(0, -3)}.js${q}`;
    if (!spec.startsWith(".")) throw new Error(`Unexpected bare import "${spec}" in ${outFile}`);
    return all;
  });
}

function compileTree(srcDir, outDir, vendorEntries) {
  const files = walk(srcDir, (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  for (const file of files) {
    const rel = relative(srcDir, file);
    const outFile = join(outDir, rel.replace(/\.ts$/, ".js"));
    const source = readFileSync(file, "utf8");
    let js;
    try {
      js = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: rel });
    } catch (err) {
      throw new Error(`Type stripping failed for ${rel}: ${err.message}`);
    }
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, rewriteSpecifiers(js, outFile, vendorEntries));
  }
  return files.length;
}

function buildManifest() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
  return configureManifest(
    { ...manifest, version: pkg.version },
    { repo: process.env.MODULE_REPO || undefined, tag: process.env.RELEASE_TAG || undefined },
  );
}

function build() {
  const started = Date.now();
  const manifest = buildManifest();
  for (const v of VENDORS) resolveVendor(v); // fail before touching dist/
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(OUT_SCRIPTS, { recursive: true });
  const vendorEntries = vendorAll();
  const count = compileTree(SRC, OUT_SCRIPTS, vendorEntries);
  for (const item of STATIC) {
    const from = join(ROOT, item);
    if (!existsSync(from)) throw new Error(`Missing static file: ${item}`);
    cpSync(from, join(DIST, item), { recursive: true });
  }
  writeFileSync(join(DIST, "module.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const entry of manifest.esmodules ?? []) {
    if (!existsSync(join(DIST, entry))) throw new Error(`module.json esmodule ${entry} was not produced`);
  }
  if (args.has("--harness")) {
    // The harness mirrors the source layout (dev/ imports ../src/...).
    const outDev = join(ROOT, "dist-dev");
    rmSync(outDev, { recursive: true, force: true });
    mkdirSync(outDev, { recursive: true });
    const devVendors = vendorAll(join(outDev, "vendor"));
    compileTree(SRC, join(outDev, "src"), devVendors);
    compileTree(join(ROOT, "dev"), join(outDev, "dev"), devVendors);
    for (const page of readdirSync(join(ROOT, "dev")).filter((f) => f.endsWith(".html"))) {
      cpSync(join(ROOT, "dev", page), join(outDev, page));
    }
    cpSync(join(ROOT, "styles"), join(outDev, "styles"), { recursive: true });
    cpSync(join(ROOT, "lang"), join(outDev, "lang"), { recursive: true });
    log("harness → dist-dev/*.html");
  }
  log(`${count} modules compiled in ${Date.now() - started} ms → ${relative(ROOT, DIST)}/`);
}

try {
  build();
} catch (err) {
  console.error("[build] failed:", err.message);
  process.exitCode = 1;
}

if (args.has("--watch")) {
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
      } catch (err) {
        console.error("[build] failed:", err.message);
      }
    }, 120);
  };
  for (const dir of ["src", "styles", "lang", "dev"]) watch(join(ROOT, dir), { recursive: true }, rebuild);
  watch(join(ROOT, "module.json"), rebuild);
  log("watching for changes…");
}
