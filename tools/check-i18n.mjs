// Checks the language files: identical key sets, no empty strings, and every
// key referenced by the source exists. Run: node tools/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREFIX = "CANVAS_SCRIBBLE";
const LANGS = ["en.json", "zh-CN.json"];

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (p.endsWith(".ts")) files.push(p);
  }
  return files;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
let errors = 0;
const fail = (msg) => {
  errors++;
  console.error(`✗ ${msg}`);
};

const langs = Object.fromEntries(
  LANGS.map((f) => [f, flatten(JSON.parse(readFileSync(join(ROOT, "lang", f), "utf8")))]),
);
const [base, ...others] = LANGS;
for (const other of others) {
  for (const key of langs[base].keys()) if (!langs[other].has(key)) fail(`${other} is missing ${key}`);
  for (const key of langs[other].keys()) if (!langs[base].has(key)) fail(`${other} has extra key ${key}`);
}
for (const f of LANGS) {
  for (const [key, value] of langs[f]) {
    if (typeof value !== "string" || !value.trim()) fail(`${f}: empty value for ${key}`);
  }
  // Placeholders must match the base language.
  if (f !== base) {
    for (const [key, value] of langs[f]) {
      const want = [...String(langs[base].get(key) ?? "").matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join();
      const have = [...String(value).matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join();
      if (want !== have) fail(`${f}: placeholders differ for ${key} ({${have}} vs {${want}})`);
    }
  }
}

// Keys referenced from source.
const used = new Set();
for (const file of walk(join(ROOT, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\b(?:t|tf|k)\("([A-Za-z.]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/notify\("(?:info|warn|error)",\s*"([A-Za-z.]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/"((?:Notify|Clear|Tools)\.[A-Z][A-Za-z]+)"/g)) used.add(m[1]);
}
// Dynamic keys (template literals in the UI).
const dynamic = {
  Tools: ["draw", "paint", "highlight", "arrow", "shape", "laser", "text", "eraser", "select", "eyedropper"],
  Brush: [
    "pen",
    "pressure",
    "pencil",
    "marker",
    "fineliner",
    "soft",
    "chalk",
    "flat",
    "calligraphy",
    "bristle",
    "pixel",
    "charcoal",
    "airbrush",
    "watercolor",
    "neon",
    "splatter",
  ],
  BrushCat: ["ink", "flat", "dry", "wet", "fx"],
  Blend: ["normal", "multiply", "screen", "overlay", "lighter"],
  AngleMode: ["fixed", "follow", "tilt", "twist"],
  FillPattern: ["solid", "hachure", "crossHatch", "dots"],
  Stabilizer: ["off", "lazy", "average"],
  Symmetry: [
    "none",
    "vertical",
    "horizontal",
    "quad",
    "radial4",
    "radial6",
    "radial8",
    "radial12",
    "kaleido3",
    "kaleido4",
    "kaleido6",
  ],
  Shape: ["line", "rect", "ellipse", "polygon"],
  Hold: ["screen", "map", "laser", "eraser"],
  "Media.Brush": ["watercolor", "wash", "ink", "gouache", "oil", "water", "smudge", "sponge"],
  "Media.Hint": ["watercolor", "wash", "ink", "gouache", "oil", "water", "smudge", "sponge"],
  "Media.Paper": ["cold", "hot", "rough", "xuan", "canvas"],
  "Dyn.Sensor": ["p", "t", "v", "d", "r"],
  "Dyn.Target": ["size", "flw", "hrd", "ang", "asp", "sct", "spc"],
  "Dyn.Combine": ["mul", "min", "max", "add"],
  "Dyn.Dir": ["abs", "rel", "axial"],
  "Dyn.Rand": ["dab", "stroke", "smooth"],
  "Dyn.Curve": ["lin", "soft", "firm", "s", "inv", "thr"],
  "Media.PaperHint": ["cold", "hot", "rough", "xuan", "canvas"],
};
for (const [group, ids] of Object.entries(dynamic)) for (const id of ids) used.add(`${group}.${cap(id)}`);
for (const m of ["screen", "map"]) for (const leaf of ["Name", "Hint"]) used.add(`Mode.${cap(m)}.${leaf}`);
for (const l of ["below", "above", "top"]) for (const leaf of ["Name", "Hint"]) used.add(`Layer.${cap(l)}.${leaf}`);
for (const s of ["mine", "screen", "mapTemp", "allTemp", "minePermanent", "permanent", "media"]) {
  for (const leaf of ["Name", "Hint"]) used.add(`Clear.${cap(s)}.${leaf}`);
}
for (const s of ["PermScreen", "PermMap", "PermPermanent", "PermManage", "PermMedia"])
  for (const leaf of ["Name", "Hint"]) used.add(`Settings.${s}.${leaf}`);
for (const h of ["Screen", "Map", "Laser", "Eraser"])
  for (const leaf of ["Name", "Hint"]) used.add(`Keys.Hold${h}.${leaf}`);

for (const key of used) {
  if (!langs[base].has(`${PREFIX}.${key}`)) fail(`missing key ${PREFIX}.${key} (used in src)`);
}

if (errors) {
  console.error(`i18n check failed with ${errors} problem(s).`);
  process.exit(1);
}
console.log(`i18n OK: ${langs[base].size} keys × ${LANGS.length} languages, ${used.size} referenced.`);
