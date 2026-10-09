# Design and implementation notes

## Compaction pipeline

`session_before_compact` intercepts automatic compaction, `/compact`, and overflow
recovery. `/compaction-method verbatim|summary` selects the method for all three
triggers, independently of Pi's auto-compaction on/off setting. The latest valid
`verbatim-compact:compaction-method` custom entry on the active branch determines
the method; absence means verbatim. Reading branch state at use time avoids stale
choices after reload, resume, fork, or tree navigation. Custom entries stay out
of model context and require no extra configuration file.

In summary mode, the hook returns no replacement. Pi generates its
usual summary with its existing boundary, instructions, and settings. In
verbatim mode, the extension:

1. Carries forward read/modified file lists from earlier verbatim compactions.
2. Removes thinking and tool results from the messages Pi selected for compaction.
3. Builds and returns a deterministic checkpoint, with compact tool signatures.

No model call, transcript write, or dump pruning occurs in the hook. Pi retains
the raw branch and persists the returned compaction entry through its normal
session machinery. If checkpoint construction fails, the hook returns no
replacement and Pi falls back to its normal compaction.

Pi selects the kept boundary before the hook runs. The extension does not change
`firstKeptEntryId` or Pi's `keepRecentTokens` setting. Recent messages remain
verbatim; the checkpoint describes the earlier portion.

## Flat spans and inherited summaries

Each compaction stores its own uncapped lines in `details.span`, with its trigger,
timestamp, and summarized message time range. Later checkpoints render spans
oldest-first inside `<compacted-span>` blocks. Consecutive preparation spans also
include the preceding compaction's retained tail, avoiding gaps and duplication.

The most recent compaction without span details becomes an opaque
`<compacted-base>` block. This supports switching from a model-generated summary
or a legacy verbatim checkpoint. Spans before that base are not re-rendered.

An actual switch to summary mode warns that applying model-summary compaction
may omit or reinterpret details. Changing the setting alone does not alter
active context: switching back before summary compaction runs leaves the
guarantee unchanged. Once a summary is applied, returning to verbatim does not
restore the earlier verbatim guarantee. Status checks, repeated selections,
resume, and summary compaction itself do not repeat this switch warning. Checkpoints with a model-summary base carry a persistent
mixed-context warning near the top: only the labelled verbatim spans and the
uncompacted tail have the guarantee. Raw history remains recoverable.

The extension wraps autocomplete through `ctx.ui.addAutocompleteProvider` when
available, amending only the built-in `/compact` suggestion's description. It
forwards completion handling and all other suggestions unchanged. Neither the
`/compact` handler nor the footer is replaced; older Pi versions without this API
retain their original description.

Trimming the rendered checkpoint does not alter original span data or raw session
entries. Historical summaries are not evidence of current file contents or test
state. Read and modified file lists are carried forward explicitly because Pi
does not automatically carry these lists from extension-provided compactions.

The closing line ("Conversation from … onward continues verbatim below") is the
last line of the checkpoint. File lists describe compacted spans and sit above
it; everything after that line is Pi's retained verbatim tail. Generated recovery
instructions contain no filesystem path to the transcript.

## Size guard

The initial cap mode is `warn`. `MECH_COMPACT_MAX_SUMMARY_PERCENT` provides the
initial percentage budget (default 25). It accepts finite numbers greater than
0 and at most 100, including decimals; invalid values fall back to 25. An
explicit `MECH_COMPACT_MAX_SUMMARY_CHARS` provides a character budget instead,
taking precedence over the percentage setting. Both are read on extension load;
session settings take precedence over either. `/cap-compaction [on|off|warn]
[<chars>c|<estimated tokens>t|<percent>%]` persists mode and budget in a
`verbatim-compact:cap-compaction` custom entry on the active branch. Omitting
mode or budget preserves it. Session entries override the initial configuration
and stay out of model context.

Budgets cover the same conversation section as before. `80000c` is identical to
the old 80,000-character guard. Token budgets resolve to four characters per
estimated token (`ceil(chars / 4)`), not an exact tokenizer count. Percentages
resolve against the current model's token context window, rounding down to whole
tokens (minimum one), then converting to characters. Thus 25% of 192,000 tokens
is 48,000 estimated tokens or 192,000 characters. Resolution at compaction time
ensures model switches affect subsequent compactions without rewriting settings.
The percentage is an estimate, not a tokenizer-enforced fraction: at 3.3–3.4
characters per token, nominal 25% occupies roughly 29–30% in actual tokens.
Use an explicit character budget for a calibrated workload; the conversion
factor is not changed based on one workload.

`on` trims without prompting; `off` leaves span lines uncapped. `warn` prompts
only when the existing cap algorithm would actually remove or shorten span
content, using the same overhead allocation and 500-character floor. The user
can apply trimming, persist `off`, change the session budget and recheck, or
cancel compaction. Esc, abort, and dialog failures cancel instead of falling
through to Pi's summary compaction. No interactive UI means warn and apply the
cap; supported RPC clients can answer the dialogs. An unresolved percentage
cancels with an error rather than guessing a budget. Automatic threshold/overflow
compactions in interactive `warn` mode can wait for input indefinitely. For
unattended runs, select `/cap-compaction on` before starting. There is no silent
timeout-to-trim policy, and the default remains `warn`.

When span content exceeds the available budget, the extension:

1. Removes the oldest non-user lines.
2. Shortens oversized user lines, each at most once.
3. Removes the oldest remaining lines until the line budget is satisfied.

The implementation accounts for section/tag overhead before capping lines, but
retains a minimum line budget of 500 characters. The inherited base summary is
not capped. Instructions, file lists, and other checkpoint text sit outside the
conversation section. This is a size guard, not a strict upper bound on the total
checkpoint or, in these exceptional cases, the conversation section.

For limited context, reduce the budget and leave room for Pi's verbatim tail,
system prompt, tools, and subsequent work. Disabling the cap still removes
thinking/tool results and abbreviates tool-call signatures; it can leave too much
context for the model, particularly during overflow recovery. The extension does not calculate a
model-specific optimal budget.

## Lookup source and transcript fidelity

Pi's append-only session is the recovery store. Compaction adds a summary entry;
it does not delete earlier messages. `context_lookup` calls
`ctx.sessionManager.getBranch()` at lookup time to obtain the full raw history.
It does not use `buildSessionContext()`, which projects the compacted model
context. Context edits likewise leave original entries available in raw history.

The active branch is searched, including all of its compactions. Other branches
and other sessions are not scanned. A fork can recover the history copied into
its own branch. In-memory sessions work while the process lives; no disk file is
required. No pre-task snapshot is needed.

The renderer creates a readable transcript and entry/section index in memory.
Each entry has an `ENTRY` header. Assistant sections are marked `[thinking]`,
`[text]`, and `[toolCall]`. Thinking, prose, tool arguments, and textual tool
outputs are untruncated in this representation. Array elements are physical
lines, so index positions map consistently to line numbers.

Lookup attribution and entry boundaries use the authoritative index, never
header-like text or rules inside transcript content. The subagent sees the
logical transcript name `session`, not a source filesystem path. Its tools
search the in-memory lines directly, so there is no temporary file or cleanup.

This is not a byte-for-byte session export. Images are represented by attachment
notes rather than binary content; system prompt checkpoint text and some
non-conversation metadata are not inlined. Pi's session JSONL is the source for
those fields. Individual tool results are bounded even though the backing
transcript is complete.

## Optional session-file override

`MECH_COMPACT_LOOKUP_SESSION_FILE` replaces the current branch with the branch
from a specified absolute session JSONL path. This supports harnesses that run
on a pruned fork but retain a full session separately. Ordinary use leaves it
unset. It is not a model-supplied tool parameter.

Each lookup checks the environment variable, validates an absolute path and a
non-empty file, then calls `SessionManager.open(file).getBranch()`. The guards
prevent Pi from initializing a missing or empty source. Opening a legacy session
can perform Pi's normal migration. Invalid overrides fail explicitly; there is
no fallback to the current/pruned branch. No ownership matching or dump selection
is involved.

## Lookup subagent

`context_lookup` constructs a separate model conversation with three tools:

- `list_entries`: list entry headers and previews.
- `grep`: regex-search lines with surrounding context and entry attribution.
- `show_entry`: retrieve an indexed entry block.

The default model is the session model. An optional `provider/modelId` can select
another registered model. An unresolved configured model falls back to the
session model. No separate process, loaded model, or external subagent extension
is required.

The default budget is ten search turns, with up to 4,096 output tokens per model
call. Exhaustion adds one tool-free call asking for partial findings. If that call
fails or returns no text, the latest assistant text is returned with an
incomplete-findings marker. Search responses and final answers have character
guards. Cancellation is passed through to model calls. Each lookup has a separate,
stable session id across its search and write-up calls. The extension does not
force `cacheRetention: "none"`; normal provider caching defaults apply, without
guaranteeing cache hits or discounts on every provider.

Findings should distinguish user instructions, observed tool output, and
historical reasoning. A past observation is not proof of current state. Recovery
still depends on model behavior, query scope, and output limits. Only final
findings reach the main agent; intermediate searches do not enter its context.

The extension appends a deterministic fallback note to turn-limit findings,
including when the final write-up fails or returns no text. It recommends
`context_list_entries`, `context_grep`, and `context_show_entry` for more detail
on the same query. Ordinary successful lookup answers are unchanged.

These three tools run the subagent's existing search functions in the main
agent, using the same call-time raw branch or session-file override. Their
results enter the main context; no model or transcript dump is needed. Their
descriptions mark them as fallbacks. The checkpoint, lookup description, and
bundled skill prefer `context_lookup`, explicitly permit these bounded tools
when findings are incomplete, and prohibit raw session JSONL/dump recovery
through filesystem tools. This is an intentional prompting change, not the
unchanged study-arm prompt.

As a safety net, `MECH_COMPACT_LOOKUP_MAX_CALLS` defaults to 1 consecutive lookup
(0 disables the limit). The count is reconstructed from lookup calls/results on
the active branch, not the override source or cached state. Their ids are counted
once; earlier pending sibling calls in the current assistant message also count,
so parallel calls cannot each take the first slot. Lookup tools request sequential
execution on Pi versions supporting that property, allowing an ordinary-work
result between calls to reset the streak deterministically. The three fallback
tools neither increase nor reset the count: direct searches belong to the same
recovery episode, so `lookup → grep → lookup` cannot repeatedly launch subagents.
Narration, thinking, and session metadata never reset it either. Only a user
message, a result outside the four recovery tools, or a bash execution resets
it. This is an operational recovery-episode boundary, not semantic detection
of whether two queries concern the same need. A blocked call returns a short fallback note without
launching a subagent. Later lookups after other work remain available within the
same user request, respecting resume, reload, compaction, and branch navigation.

## Bounded search and pagination

The raw transcript remains complete. Grep/entry retrieval retain their existing
12,000/24,000-character payload limits; listings now have a 12,000-character
payload limit too. Attribution and small cursor/status notes sit outside these
payload limits. Shared functions and schemas provide the same pagination to the
subagent and main-agent fallback tools.

- `list_entries` / `context_list_entries`: `offset` is a character offset into
  the rendered listing (default 0).
- `show_entry` / `context_show_entry`: `offset` is a character offset into the
  rendered entry (default 0). `maxLines` is a per-page line budget (default 400,
  minimum 1), with the independent character guard still applied. Continuations
  repeat authoritative entry attribution, even when they start inside a line.
- `grep` / `context_grep`: all matches are counted, not silently cut at the first
  15. `maxMatches` limits each page (default 15), and `offset` is the zero-based
  match index. If a match's surrounding context exceeds the remaining character
  budget, the response reports both `offset` and `charOffset` for continuing that
  match, repeating its authoritative entry/section attribution. Notices report
  how many matches remain, including a partially shown match.

Character offsets use JavaScript UTF-16 code units, not bytes or tokens. Limited
pages print exact continuation parameters; keep other parameters unchanged.
The source is rendered on every invocation without snapshots. Listing/grep
continuations include `throughEntry`, the original last entry id, to keep the
source boundary and listing count stable as new calls/results append. Without
that boundary a broad search could keep finding its own paginated responses.
A missing boundary fails explicitly rather than silently widening the search.
Changing branches or search/context parameters requires restarting at offset 0
without `throughEntry`. Page boundaries do not split UTF-16 surrogate pairs.
Pagination exposes oversized individual lines without removing the output guard.

`truncateHead` (formerly misleadingly named `truncateMiddle`) is still used for
short previews, attribution/status guards, and final subagent findings. Its
truncation notice reports omitted characters. Retrieval pages use continuation
instead of permanently hiding a suffix.

The subagent does not inherit the main agent's skill inventory. Its instructions
come directly from the extension. The bundled skill supplies complementary
workflow guidance, not a required lookup runtime component.

## Configuration and compatibility

Model selection, turn budget, consecutive-call limit, and size guard are read at
extension load. The session-file override is read at lookup time. There is no
extension-specific JSON configuration or automatic `.env` loading. Pi's own compaction settings control
when compaction occurs and how much recent context is retained.

`dump_context`, `/dump-context`, and `dumpDir` are not exposed. Old dump roots and
git-ignore warning settings are unused; existing dump files are not read, pruned,
or deleted. Upgrade the extension and skill together to remove obsolete snapshot
instructions. The release has no experiment arm switches or custom model-summary
prompts. `/tree` branch summarization is not intercepted.
