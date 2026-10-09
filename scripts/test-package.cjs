"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { piRoot } = require("./pi-runtime.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.private, true, "GitHub-only staging must not publish accidentally");
  assert.equal(manifest.license, "MIT");
  assert(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./source/extensions/verbatim-compact.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./source/skills/context-retrieval"]);
  assert(!manifest.dependencies, "host-provided runtime packages must not be bundled");

  const packResult = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  }));
  // npm 12 keys results by package name; earlier versions return an array.
  const [packed] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const resource of ["source/extensions/verbatim-compact.ts", "source/skills/context-retrieval/SKILL.md"]) {
    assert(packedPaths.has(resource), `npm package includes ${resource}`);
  }

  const { DefaultPackageManager } = await import(pathToFileURL(path.join(piRoot, "dist/core/package-manager.js")).href);
  const { SettingsManager } = await import(pathToFileURL(path.join(piRoot, "dist/core/settings-manager.js")).href);
  const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
  const { loadSkills } = await import(pathToFileURL(path.join(piRoot, "dist/core/skills.js")).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-package-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    const manager = new DefaultPackageManager({ cwd: root, agentDir: temp, settingsManager });
    const resources = await manager.resolveExtensionSources([root], { temporary: true });
    const extensionPaths = resources.extensions.filter((r) => r.enabled).map((r) => r.path);
    const skillPaths = resources.skills.filter((r) => r.enabled).map((r) => r.path);
    assert.deepEqual(extensionPaths, [path.join(root, "source", "extensions", "verbatim-compact.ts")], "Pi discovers exactly the intended extension");
    assert.equal(skillPaths.length, 1, "Pi discovers the bundled skill");
    const loaded = await loadExtensions(extensionPaths, root);
    assert.deepEqual(loaded.errors, [], "real Pi extension loader reports no errors");
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.deepEqual([...extension.tools.keys()], ["context_list_entries", "context_grep", "context_show_entry", "context_lookup"], "session lookup and three direct fallback tools are registered");
    assert.deepEqual([...extension.commands.keys()], ["compaction-method", "cap-compaction"], "method and cap selection are registered, with no dump or replacement compact command");
    const lookup = extension.tools.get("context_lookup");
    assert.deepEqual(Object.keys(lookup.definition.parameters.properties), ["question"], "lookup has no dump-selection argument");
    const skills = loadSkills({ cwd: root, agentDir: temp, skillPaths, includeDefaults: false });
    assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0].name, "context-retrieval");
    assert.deepEqual(skills.diagnostics, []);
    assert.equal([...packedPaths].filter((p) => p.startsWith("source/extensions/")).length, 1, "package ships one extension under its public name");
    console.log("PACKAGE TEST OK — manifest, packed resources, real Pi loader, session lookup, and bundled skill");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("PACKAGE TEST FAILED:", err);
  process.exit(1);
});
