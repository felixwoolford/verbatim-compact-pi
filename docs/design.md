# Design and implementation notes

## Compaction pipeline

`session_before_compact` intercepts automatic compaction, `/compact`, and overflow
recovery. The extension:

1. Writes the current branch to a transcript dump.
2. Prunes older dumps whose indexed entries are all present in the new dump.
3. Carries forward read/modified file lists from earlier verbatim compactions.
4. Removes thinking and tool results from the messages Pi selected for compaction.
5. Builds and returns the deterministic checkpoint.

If dumping or checkpoint construction fails, the hook returns no replacement and
Pi falls back to its normal compaction. Pruning failures only produce a warning.

Pi selects the kept boundary before the hook runs. The extension does not change
`firstKeptEntryId` or Pi's `keepRecentTokens` setting. Recent messages remain
verbatim; the checkpoint describes the earlier portion.

## Flat spans and inherited summaries

Each verbatim compaction stores its own uncapped lines in `details.span`, with
its trigger, timestamp, and summarized message time range. Later checkpoints
render the available spans oldest-first inside `<compacted-span>` blocks.

The most recent compaction without span details becomes an opaque
`<compacted-base>` block. This supports switching from a model-generated summary
or a legacy verbatim checkpoint. Spans before that base are not re-rendered.

The rendered checkpoint can be trimmed without changing the original span data
or the transcript dump. Historical summaries are not evidence of current file
contents or test state.

Read and modified file lists are carried forward explicitly because Pi does not
automatically carry these lists from extension-provided compactions.

The rendered layout has one invariant: the closing line ("Conversation from …
onward continues verbatim below") is the last line of the checkpoint. The file
lists describe the compacted spans and therefore sit above it, so everything
after the closing line is Pi's retained verbatim tail.

## Size guard

`MECH_COMPACT_MAX_SUMMARY_CHARS` defaults to 80,000. It is a character budget for
the conversation section, not a token budget for the entire model context.

When span content exceeds the available budget, the extension:

1. Removes the oldest non-user lines.
2. Shortens oversized user lines, each at most once.
3. Removes the oldest remaining lines until the line budget is satisfied.

The implementation accounts for section/tag overhead before capping lines, but
retains a minimum line budget of 500 characters. The inherited base summary is
not capped. Instructions, file lists, and other checkpoint text also sit outside
the line budget. Consequently this setting is a size guard, not a strict upper
bound on either the total checkpoint or, in these exceptional cases, the
conversation section.

For a model with limited context, reduce this value and leave room for Pi's
verbatim tail, system prompt, tools, and subsequent work. The extension does not
calculate a model-specific optimal budget.

## Dump format and fidelity

`conversation.md` is a readable serialization of the branch. Assistant sections
are marked `[thinking]`, `[text]`, and `[toolCall]`. Thinking, prose, tool arguments,
and textual tool outputs are not truncated by the dump writer.

`meta.json` indexes entry start/end lines and assistant section boundaries.
Lookup attribution uses this index rather than trusting header-like text inside
the transcript. Pre-index dumps use a scanning fallback.

This is not a byte-for-byte session export. Images are represented by attachment
notes rather than binary content; system prompt checkpoint text and some
non-conversation metadata are not inlined. Pi's session JSONL remains the source
for those fields.

## Dump location and git-ignore warning

By default dumps are written to `<project>/.pi/context-dumps/`. The environment
variable `MECH_COMPACT_DUMP_DIR` replaces that root with an absolute path (for
example `~/.pi/context-dumps`), useful where the project tree is versioned and
the dump location cannot be ignored. Relative values are rejected with a
warning and the default root is used. Writes, pruning, and lookup all resolve
the same root, so an override is consistent across the extension. Session
ownership and pruning are keyed on entry ids, not directories, so a root shared
by several projects keeps foreign sessions' dumps out of lookups and never
prunes across sessions.

Because dumps can contain credentials and conversation text, the extension
checks git state when it writes a dump: if the dump root is inside a git
worktree and `git check-ignore` reports the location as not ignored, it emits
one warning per process per dump root, suggesting a `.gitignore` entry or
`MECH_COMPACT_DUMP_DIR`. Roots outside the project (an explicit override),
non-git directories, and ignored locations produce no warning. Git failures
time out after three seconds and are treated as "nothing to warn about"; the
check never blocks or fails the dump. `MECH_COMPACT_WARN_GITIGNORE` set to a
falsy value (`0`, `off`, `no`, `false`) disables the warning entirely; the
dump itself is unaffected either way.

## Ownership and pruning

Indexed dumps belong to the current session history when they contain its
branch's first entry ID. Pre-index dumps fall back to matching the session file;
without a session file they are excluded from automatic selection.

Forks copy entry IDs, so they can see their parent's history. An explicit dump
name or absolute path deliberately bypasses automatic ownership filtering.

A candidate dump is pruned only if:

- It belongs to the session's history.
- Its metadata contains a non-empty entry index.
- Every indexed entry ID occurs in the new dump.
- Its resolved path is inside the dump root and is not the newly written dump.

Abandoned-branch dumps, foreign dumps, pre-index dumps, and unreadable metadata
are retained. Informational `previous dump:` paths inside a later transcript may
refer to a pruned directory.

## Lookup subagent

`context_lookup` constructs a separate model conversation with three tools:

- `list_entries`: list entry headers and previews.
- `grep`: search transcript lines with surrounding context and entry attribution.
- `show_entry`: retrieve an indexed entry block.

The default model is the session model. An optional `provider/modelId` can select
another registered model. An unresolved configured model currently falls back
to the session model. No separate process, loaded model, or external subagent
extension is required.

The default budget is ten search turns, with up to 4,096 output tokens per model
call. One additional tool-free call is used when the search budget is exhausted,
asking for partial findings. If it fails or returns no text, the latest assistant
text is returned with an incomplete-findings marker. Search responses and final
answers have character guards to limit returned content.

Findings should identify user instructions, observed tool output, and historical
reasoning separately. A past observation is not proof of current state. Lookup
success still depends on model behavior, query scope, and tool-output limits.

The lookup conversation does not inherit the main agent's skill inventory. Its
instructions are supplied directly by the extension. The main agent's bundled
skill is complementary guidance, not a required lookup runtime component.

## Configuration and scope

The three supported settings are environment variables read at extension load.
There is no extension-specific JSON configuration or automatic `.env` loading.
Pi's normal compaction settings still control when compaction occurs and how much
recent context is retained.

The release contains only verbatim compaction. Experiment arm switches,
custom model-summary prompts, and dump-root overrides are not included.

`/tree` branch summarization is not intercepted.
