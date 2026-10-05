# Contributing

## Setup

Use Node.js 22.19 or newer:

```bash
npm ci --ignore-scripts
npm test
```

The development dependency pins Pi 1.0.3. Runtime imports are host-provided peer
dependencies; do not bundle additional copies of Pi's runtime packages.

To test against an existing Pi installation instead, point to its package root:

```bash
PI_PACKAGE_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

This must be a package directory containing `dist/index.js`, not the CLI binary.
The test helper also checks local dependencies and global npm installations.

## Tests

`npm test` runs:

- Synthetic-session integration tests for dumps, checkpoints, spans, file lists,
  attribution, ownership, pruning, and lookup dispatch.
- Default-budget retention and size-guard tests.
- Small-budget termination and cross-span trimming regressions.
- Exhausted lookup write-up and failure-fallback tests.
- Git-ignore warning tests (un-ignored repo warns once, memoized; ignored repo
  silent; skipped when git is unavailable) and a `MECH_COMPACT_WARN_GITIGNORE=0`
  suppression test (own process, since the flag is read at module load).
- `MECH_COMPACT_DUMP_DIR` redirection test (dump written outside the project,
  lookup resolves it), run as its own process because the override is read at
  module load.
- A package smoke test using Pi's real package resolver, extension loader, and
  skill loader.

No model calls, credentials, or GPU are needed. Test data is synthetic, and dumps
are written under the operating system's temporary directory. Some integration
test directories are retained for inspection.

The test runner clears the extension's configuration variables in its child
processes so personal settings do not change default-budget assertions. Run
individual `test:*` scripts when intentionally testing environment overrides.
Some existing stubbed tool sequences need at least four lookup turns.

## Manual check

Load the checkout with `pi -e /absolute/path/to/verbatim-compact`, avoiding duplicate
installed copies. In a disposable project, take an on-demand dump, trigger
`/compact`, and ask for a known earlier tool result through `context_lookup`.
Verify the retained boundary and file lists as well as the returned answer.

Do not use real credentials or private conversation dumps in fixtures. Reports
should include the Pi version, model/provider, relevant settings, and a minimal
redacted reproduction. Recovered thinking is not independently verified evidence.

## Changes

Keep runtime behavior and documentation consistent. Add a regression for changes
to span boundaries, ownership, pruning, or lookup limits. Put evaluation results
in `docs/` and distinguish unit/integration tests from model-quality experiments.

The source is loaded as TypeScript by Pi; no build step is required. Contributions
are distributed under the project's MIT license.
