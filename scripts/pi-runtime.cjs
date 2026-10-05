"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

// Inspect ordinary node_modules locations without depending on package.json
// exports or CommonJS entry points: Pi's packages are import-only ESM.
function packageRoot(name, from) {
  const req = createRequire(path.join(from, "package.json"));
  for (const modules of req.resolve.paths(name) ?? []) {
    const candidate = path.join(modules, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Cannot locate ${name} from ${from}`);
}

function findPiRoot() {
  if (process.env.PI_PACKAGE_DIR) return path.resolve(process.env.PI_PACKAGE_DIR);
  try {
    return packageRoot("@earendil-works/pi-coding-agent", path.resolve(__dirname, ".."));
  } catch {
    // Fall back to an existing global Pi installation.
  }
  const candidates = [
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
  ];
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    }).trim();
    if (root) candidates.unshift(path.join(root, "@earendil-works/pi-coding-agent"));
  } catch {
    // npm is optional when PI_PACKAGE_DIR or a known global location works.
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "dist", "index.js"))) return candidate;
  }
  throw new Error("Cannot find Pi. Run npm ci or set PI_PACKAGE_DIR to its package directory.");
}

const piRoot = findPiRoot();
if (!fs.existsSync(path.join(piRoot, "dist", "index.js"))) {
  throw new Error(`PI_PACKAGE_DIR must contain dist/index.js: ${piRoot}`);
}
const jitiAliases = {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-agent-core": path.join(packageRoot("@earendil-works/pi-agent-core", piRoot), "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(packageRoot("@earendil-works/pi-ai", piRoot), "dist", "compat.js"),
  typebox: require.resolve("typebox", { paths: [piRoot] }),
};

module.exports = { piRoot, jitiAliases };
