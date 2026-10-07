"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const env = { ...process.env };
// User settings must not alter the default-budget / default-turn regressions.
for (const key of ["MECH_COMPACT_MAX_SUMMARY_CHARS", "MECH_COMPACT_LOOKUP_MODEL", "MECH_COMPACT_LOOKUP_TURNS", "MECH_COMPACT_LOOKUP_SESSION_FILE"]) {
  delete env[key];
}
for (const args of [
  ["test.cjs"],
  ["test.cjs", "cap"],
  ["test.cjs", "caphang"],
  ["test.cjs", "capspans"],
  ["test.cjs", "capdefault"],
  ["scripts/test-package.cjs"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
