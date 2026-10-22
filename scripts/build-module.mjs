#!/usr/bin/env node
// Build the installable Foundry module: dist/foundry-flight-recorder/ (+ .zip when `zip` exists).
// Usage: node scripts/build-module.mjs [--install <FoundryData>/Data/modules]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "packages/foundry-module");
const id = JSON.parse(fs.readFileSync(path.join(src, "module.json"), "utf8")).id;
const out = path.join(root, "dist", id);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
// cpSync keeps symlinks even with `dereference`: materialize the shared schema explicitly.
const schema = path.join(out, "scripts/schema.mjs");
fs.rmSync(schema);
fs.copyFileSync(path.join(root, "packages/schema/schema.mjs"), schema);
console.log(`built ${path.relative(root, out)}`);
try {
  fs.rmSync(`${out}.zip`, { force: true });
  execFileSync("zip", ["-qr", `${id}.zip`, id], { cwd: path.dirname(out) });
  console.log(`packed dist/${id}.zip`);
} catch { console.log("zip not available: skipped archive"); }
const i = process.argv.indexOf("--install");
if (i > 0) {
  const dest = path.join(process.argv[i + 1], id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(out, dest, { recursive: true });
  console.log(`installed to ${dest}`);
}
