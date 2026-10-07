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

The initial cap policy is `warn 25%`. An explicit `MECH_COMPACT_MAX_SUMMARY_CHARS`
provides an initial character budget instead. `/cap-compaction [on|off|warn]
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

`on` trims without prompting; `off` leaves span lines uncapped. `warn` prompts
only when the existing cap algorithm would actually remove or shorten span
content, using the same overhead allocation and 500-character floor. The user
can apply trimming, persist `off`, change the session budget and recheck, or
cancel compaction. Esc, abort, and dialog failures cancel instead of falling
through to Pi's summary compaction. No interactive UI means warn and apply the
cap; supported RPC clients can answer the dialogs. An unresolved percentage
cancels with an error rather than guessing a budget.

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
guards. Cancellation is passed through to model calls.

Findings should distinguish user instructions, observed tool output, and
historical reasoning. A past observation is not proof of current state. Recovery
still depends on model behavior, query scope, and output limits. Only final
findings reach the main agent; intermediate searches do not enter its context.

The subagent does not inherit the main agent's skill inventory. Its instructions
come directly from the extension. The bundled skill supplies complementary
workflow guidance, not a required lookup runtime component.

## Configuration and compatibility

Model selection, turn budget, and size guard are read at extension load. The
session-file override is read at lookup time. There is no extension-specific JSON
configuration or automatic `.env` loading. Pi's own compaction settings control
when compaction occurs and how much recent context is retained.

`dump_context`, `/dump-context`, and `dumpDir` are not exposed. Old dump roots and
git-ignore warning settings are unused; existing dump files are not read, pruned,
or deleted. Upgrade the extension and skill together to remove obsolete snapshot
instructions. The release has no experiment arm switches or custom model-summary
prompts. `/tree` branch summarization is not intercepted.
