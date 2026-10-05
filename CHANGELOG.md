# Changelog

## Unreleased — initial release preparation

- Deterministic compaction checkpoints retain user messages and assistant prose,
  subject to a size guard; thinking and tool outputs remain recoverable in dumps.
- Flat, chronological spans avoid repeatedly summarizing earlier facts.
- Entry-indexed transcript dumps support attributed lookup results.
- Session-scoped lookup and containment-based pruning preserve abandoned branches.
- `context_lookup` uses a subagent with list, grep, and entry-retrieval tools.
- Exhausted lookups receive one final tool-free write-up of partial findings.
- Default conversation-section budget: 80,000 characters.
- On-demand `/dump-context` command and `dump_context` tool.
- `MECH_COMPACT_DUMP_DIR` moves the dump root outside the project tree
  (absolute path required).
- One-time warning when dumps land in a git worktree that does not ignore
  them; `MECH_COMPACT_WARN_GITIGNORE=0` disables the warning.
- Bundled `context-retrieval` skill, including narrowly scoped evidence-recovery guidance.
- Preliminary synthetic pilot results, with limitations and exclusions documented.

No version has been published from this staging directory. Full evaluation is pending.
