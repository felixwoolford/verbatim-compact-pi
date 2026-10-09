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
  receive one final tool-free write-up of partial findings. The extension appends
  fallback guidance even when the write-up fails or its findings are truncated.
- Hybrid recovery is now the default: `context_list_entries`, `context_grep`, and
  `context_show_entry` provide bounded direct search when subagent findings are
  incomplete. The checkpoint, tool descriptions, and bundled skill consistently
  permit these tools while prohibiting raw session-file recovery through
  filesystem tools. This intentionally changes recovery prompting.
- `MECH_COMPACT_LOOKUP_MAX_CALLS` defaults to 1 consecutive lookup attempt
  (0 = unlimited). User messages, ordinary-work tool results, and bash executions
  reset the limit; narration and thinking do not. The three direct fallback
  tools neither increase nor reset the count, preventing alternating lookup/
  direct-search cycles from repeatedly launching subagents. Branch-based call/result
  accounting also covers pending earlier calls in a batch, preventing parallel
  lookups from bypassing the cap. Lookup requests use sequential execution when
  supported by Pi.
- Shared subagent/direct search tools now support complete paginated retrieval,
  with continuation cursors and explicit remaining-content notices, including
  oversized individual lines. Listing/grep cursors pin the original last entry
  id, excluding newly appended calls/results without creating a snapshot. Existing grep/entry payload guards remain 12,000/
  24,000 characters; entry listings are now paginated at 12,000 characters.
  `truncateMiddle` was renamed to `truncateHead` to match its actual behavior.
  These are retrieval changes, not new measurements of historical study arms.
- Lookup model calls no longer force caching off; provider defaults apply, with
  a stable separate session id for each lookup. Cache eligibility remains
  provider-dependent.
- Session/branch-persistent `/cap-compaction [on|off|warn] [80000c|20000t|25%]`
  controls trimming; the default is `warn 25%` of the current model context window.
  Tokens use a four-characters-per-token estimate (now explicit in budget status),
  percentages follow model changes, and explicit character
  budgets retain the existing scope and algorithm. The environment character
  setting remains an initial-budget override.
- `MECH_COMPACT_MAX_SUMMARY_PERCENT` configures the initial percentage budget
  (default 25, fractional values supported). Session settings override explicit
  character settings, which override the percentage setting; invalid percentages
  fall back to 25.
- Trim prompts can apply the cap, persist `off`, change the budget, or cancel.
  Non-interactive mode warns and caps; cancellation never falls through to summary.
  For unattended interactive sessions, use `/cap-compaction on` to avoid waiting
  for trim dialogs. The `warn` default and conversion factor are unchanged.
- Removed `/dump-context`, `dump_context`, and the `dumpDir` lookup argument;
  old dump-directory and git-ignore warning settings are unused.
- Bundled `context-retrieval` skill describes session-backed evidence recovery,
  branch scope, historical provenance, and re-verification after compaction.
- Deterministic tests cover session recovery, overrides, attribution, size guards,
  cap dialogs/modes/budgets, percentage defaults/model changes, cancellation,
  the skill, and Pi's real package loader. Hybrid regressions additionally cover
  narration, same-message/parallel attempts, pagination and oversized lines,
  truncation boundaries, provider caching options, and real Pi agent-turn
  persistence ordering with a stubbed model (no live inference).
- Preliminary synthetic pilot figures are preserved as historical results from
  the dump-based implementation, not measurements of the current implementation.

No version has been published from this staging directory. Full evaluation is pending.
