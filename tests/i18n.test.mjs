// Every FFR.* key referenced by the module exists in en.json and fr.json (and the two files match).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const dir = "packages/foundry-module";
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
const en = new Set(flat(JSON.parse(fs.readFileSync(`${dir}/lang/en.json`, "utf8"))));
const fr = new Set(flat(JSON.parse(fs.readFileSync(`${dir}/lang/fr.json`, "utf8"))));

test("en and fr define the same keys", () => assert.deepEqual([...en].sort(), [...fr].sort()));

test("every key used in main.mjs is defined", () => {
  const src = fs.readFileSync(`${dir}/scripts/main.mjs`, "utf8");
  const used = new Set();
  for (const m of src.matchAll(/"FFR\.([\w.]+)"/g)) used.add(`FFR.${m[1]}`);
  for (const m of src.matchAll(/\bL\("([\w.]+)"/g)) used.add(`FFR.${m[1]}`);
  for (const m of src.matchAll(/S\("(\w+)"\)/g)) { used.add(`FFR.Settings.${m[1]}.name`); used.add(`FFR.Settings.${m[1]}.hint`); }
  // dynamic keys: Badge.${s}, Badge.${s}Tip, Mode.${m}, Menu.${action}, Friction.${k}
  for (const s of ["rec", "optout", "idle"]) { used.add(`FFR.Badge.${s}`); used.add(`FFR.Badge.${s}Tip`); }
  for (const a of ["friction", "optout", "optin", "start", "stop", "close"]) used.add(`FFR.Menu.${a}`);
  for (const k of ["confusing", "difficult", "broken", "slow", "rules", "other"]) used.add(`FFR.Friction.${k}`);

  assert.deepEqual([...used].filter((k) => !en.has(k)), []);
});
