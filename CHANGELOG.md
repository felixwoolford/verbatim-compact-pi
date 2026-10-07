# Changelog

## Unreleased — initial release preparation

- Deterministic checkpoints retain user messages and assistant prose, subject to
  a size guard; thinking, full tool outputs, and arguments remain in Pi's session.
- Flat chronological spans avoid repeatedly summarizing earlier facts.
- Session-persistent `/compaction-method verbatim|summary` selects manual,
  automatic, and overflow-recovery compaction independently of auto-compaction
  on/off. `/compact` autocomplete reflects the method when supported, without
  replacing the command or footer.
- Summary-mode warnings appear only on actual switches, not status checks or
  compaction. They clarify that changing the setting alone does not alter context.
  Mixed-context warnings explicitly scope the verbatim guarantee; switching back
  after applying a summary cannot restore earlier model-summarized context to verbatim.
- Session-backed `context_lookup` searches the full raw active branch across all
  compactions, using an in-memory transcript with authoritative entry attribution.
- No local transcript dump, temporary file, ownership matching, or pruning.
- Optional `MECH_COMPACT_LOOKUP_SESSION_FILE` supports full-session recovery from
  pruned harness forks, with explicit failures for invalid overrides.
- Subagent lookup provides list, grep, and entry-retrieval tools; exhausted lookups
  receive one final tool-free write-up of partial findings.
- Session/branch-persistent `/cap-compaction [on|off|warn] [80000c|20000t|25%]`
  controls trimming; the default is `warn 25%` of the current model context window.
  Tokens are estimated, percentages follow model changes, and explicit character
  budgets retain the existing scope and algorithm. The environment character
  setting remains an initial-budget override.
- Trim prompts can apply the cap, persist `off`, change the budget, or cancel.
  Non-interactive mode warns and caps; cancellation never falls through to summary.
- Removed `/dump-context`, `dump_context`, and the `dumpDir` lookup argument;
  old dump-directory and git-ignore warning settings are unused.
- Bundled `context-retrieval` skill describes session-backed evidence recovery,
  branch scope, historical provenance, and re-verification after compaction.
- Deterministic tests cover session recovery, overrides, attribution, size guards,
  cap dialogs/modes/budgets, percentage defaults/model changes, cancellation,
  the skill, and Pi's real package loader.
- Preliminary synthetic pilot figures are preserved as historical results from
  the dump-based implementation, not measurements of the current implementation.

No version has been published from this staging directory. Full evaluation is pending.
