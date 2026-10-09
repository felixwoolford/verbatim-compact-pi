"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const env = { ...process.env };
// User settings must not alter the default-budget / default-turn regressions.
for (const key of ["MECH_COMPACT_MAX_SUMMARY_CHARS", "MECH_COMPACT_MAX_SUMMARY_PERCENT", "MECH_COMPACT_LOOKUP_MODEL", "MECH_COMPACT_LOOKUP_TURNS", "MECH_COMPACT_LOOKUP_MAX_CALLS", "MECH_COMPACT_LOOKUP_SESSION_FILE"]) {
  delete env[key];
}
for (const args of [
  ["test.cjs"],
  ["test.cjs", "cap"],
  ["test.cjs", "caphang"],
  ["test.cjs", "capspans"],
  ["test.cjs", "capdefault"],
  ...[
    ["30", "30%"], ["12.5", "12.5%"], ["100", "100%"],
    ["0", "25%"], ["-1", "25%"], ["100.1", "25%"],
    ["not-a-number", "25%"], ["Infinity", "25%"], ["25%", "25%"],
    ["30", "80000c", "80000"],
  ].map((args) => ["test.cjs", "capenv", ...args]),
  ...[
    ["0", "0"], ["2", "2"], ["-1", "1"], ["1.5", "1"],
    ["not-a-number", "1"], ["2oops", "1"], ["Infinity", "1"], ["", "1"],
  ].map((args) => ["test.cjs", "lookupenv", ...args]),
  ["scripts/test-package.cjs"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
