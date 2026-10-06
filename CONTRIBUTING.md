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

This must contain `dist/index.js`, not be the CLI binary. The test helper also
checks local dependencies and global npm installations.

## Tests

`npm test` runs:

- Synthetic-session integration tests using real Pi session managers and stubbed
  model responses: recovery across three compactions, full thinking/output/args,
  flat spans, cumulative file lists, branch scoping, and exact entry rendering.
- Skill validation and agreement with the question-only lookup contract.
- Header/section spoofing resistance and internal lookup tool dispatch.
- Absolute session-file override tests, including pruned forks, reload at lookup
  time, invalid paths, missing/empty files, and no silent fallback.
- Empty/no-model, cancellation, provider-error, and exhausted write-up tests.
- Default-budget retention, small-budget termination, and cross-span size guards.
- A package smoke test checking `npm pack --dry-run`, then Pi's real package
  resolver, extension loader, registered tool/schema, and skill loader.

No live model calls, credentials, network inference, or GPU are needed. Fixtures
and temporary session files are synthetic and removed after the tests. The
runner clears configuration variables in child processes so personal settings
cannot redirect lookups to real session files.

Individual scripts are `test:integration`, `test:cap`, `test:caphang`,
`test:capspans`, and `test:package`.

## Manual check

Load the checkout with `pi -e /absolute/path/to/verbatim-compact`, avoiding duplicate
installed copies. In a disposable project, produce a distinctive tool result,
trigger `/compact`, and ask for the exact earlier result through `context_lookup`.
Repeat across several compactions. Verify the retained boundary, file lists,
entry citations, and that no local transcript dump is created.

Do not use real credentials or private session history in fixtures. Reports
should include the Pi version, model/provider, relevant settings, and a minimal
redacted reproduction. Recovered thinking is not independently verified evidence.

## Changes

Keep runtime behavior, skill instructions, and documentation consistent. Add a
regression for changes to span boundaries, branch scope, lookup sources, or output
limits. Put evaluation results in `docs/` and distinguish integration tests from
model-quality experiments. Historical pilot figures must remain labeled with the
implementation actually evaluated.

The source is loaded as TypeScript by Pi; no build step is required. Contributions
are distributed under the project's MIT license.
