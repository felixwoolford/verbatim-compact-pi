# verbatim-compact

Deterministic context compaction for [Pi](https://pi.dev/), with session-backed
recovery. By default, replaces Pi's model-generated compaction summary with a checkpoint
built mechanically from conversation text. Thinking and tool outputs are removed
from the active model context, while user inputs, assistant text, and tool call stubs are retained verbatim.

Verbatim compaction itself makes no model call. When a
missing detail is needed, `context_lookup` runs a subagent over the session's
full raw branch and returns only relevant findings.

The goal is to let the agent withstand ~8 compactions without the copy-of-a-copy degradation of model-summary compaction, which is exacerbated in sub-frontier models.

The defining property of verbatim-compact is the guarantee that all history is either kept
verbatim in context or stripped entirely from it; nothing is ever compressed in
between. Every verbatim compaction is also followed by a re-orientation block that tells the agent what was removed and what remaining information must be verified before being relied on.
Tests indicate that this helps weaker models to avoid confabulating the historical context and to more carefully verify what it does and does not know.

The primary intended use case is on a strong local LLM with a reasonably large context window (128k+) : for example, **Qwen 3.8 27B through
llama.cpp on an RTX 5090**. Recovery uses
the session model by default and does not require a second model to be loaded.
Performance improvements over compaction are greatest in this use case, but the tool is also effective with frontier models.
Performance benchmarking with frontier models is WIP.

## Install

Requires Pi and Node.js 22.19 or newer. Tests currently target **Pi 1.0.3**;
other versions have not been verified here.

### Package installation

Install from git:

```bash
pi install git:github.com/felixwoolford/verbatim-compact-pi
```

or from a downloaded or cloned checkout:

```bash
pi install /absolute/path/to/verbatim-compact
```

This installs both the extension and the `context-retrieval` skill. Run `/reload`
in an existing Pi session, or restart Pi.

Use `pi install --local <source>` for a project-only installation. To load a
local checkout for one invocation without saving an installation:

```bash
pi -e /absolute/path/to/verbatim-compact
```

Remove previously copied extensions and skills before installing the package,
so only one copy loads. Replace older copies of **both** resources when updating.

### Manual installation

From the checkout directory:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp extensions/verbatim-compact.ts ~/.pi/agent/extensions/
cp -r skills/context-retrieval ~/.pi/agent/skills/
```

Then `/reload`. Project equivalents are `.pi/extensions/` and `.pi/skills/`.

### Uninstallation

To uninstall a package, use `pi remove <the-source-you-installed>` and `/reload`.
For manual installation, remove the copied extension and skill, then `/reload`.
Pi's existing session files are unaffected.

## Usage

Pi's compaction uses verbatim-compact by default once the extension is loaded.
To compact manually:

```text
/compact
```

### Select the compaction method

```text
/compaction-method
/compaction-method verbatim
/compaction-method summary
```

`/compaction-method` is available to opt-in to Pi's builtin summary compaction for the current session.

With no argument, the command reports the current method. A summary-mode warning
appears when actually switching to summary, but not on repeated selections,
resume, or compaction.
The choice applies to
manual `/compact`, automatic threshold compaction, and context-overflow recovery.

The choice persists in the existing session, follows branch history through
reload, resume, fork, and tree navigation, and needs no extra configuration file.
New sessions default to verbatim. The footer is unchanged. On Pi versions with
`addAutocompleteProvider`, `/compact`'s description changes to “Manually compact
with verbatim-compact” or “Manually compact with summary compaction”; older
versions retain the built-in description. The `/compact` command itself is not
replaced, and Pi handles custom summary instructions normally in summary mode.

> **Applying summary compaction weakens the verbatim guarantee.** Changing this
> setting does not alter active context; switching back to verbatim before summary
> compaction runs leaves the guarantee unchanged. If summary compaction runs
> (manually or automatically), it replaces older active context with a
> model-generated summary, which may omit or reinterpret details. Switching back
> afterward does not undo this: only subsequent verbatim spans retain the
> guarantee. Original history remains recoverable through `context_lookup`, but
> is no longer directly present in active context.

Later verbatim checkpoints containing a model-summary base prominently warn:
**Mixed context: earlier material is model-summarized, not verbatim.** The
verbatim guarantee applies only to the labelled verbatim spans and uncompacted
tail—not to the opaque summary base.

### Control the compaction cap

The default is **`warn 25%`**: a conversation-section budget estimated at 25% of
the current model's context window, using **4 characters per token**, not an
exact tokenizer. When content would actually be trimmed, choose **Apply trimming**,
**Disable cap for this session**, **Change budget**, or **Cancel compaction**. Disabling persists as `off`, rather than
bypassing just once. Cancel or Esc cancels compaction; it does not fall through
to summary compaction.

```text
/cap-compaction                 # report mode and budget
/cap-compaction warn             # prompt before trimming (default)
/cap-compaction on               # trim without prompting
/cap-compaction off              # disable cap-based trimming
/cap-compaction warn 20000t      # estimated tokens
/cap-compaction warn 25%         # percentage of model context window
/cap-compaction on 80000c        # the original character guard
```

Mode and budget are independent: omitting either preserves it. Budget-only input
such as `/cap-compaction 40000c` also works. Both settings persist in the session
and follow branch history through reload, resume, fork, and tree navigation.
They apply only to verbatim compaction, not summary compaction, and do not change
Pi's auto-compaction enabled setting.

Tokens are estimated with `ceil(chars / 4)`, not an exact tokenizer. For a
192,000-token window, `25%` gives 48,000 estimated tokens, equivalent to 192,000
characters. Percentages follow the current model's context window after model
changes; fractional token budgets round down, with a minimum of one token.
`80000c` preserves the existing budget scope and trimming algorithm exactly.
See [how cap trimming works](#how-cap-trimming-works) for the removal order.

The budget is a size guard, not a guarantee that the whole model context fits.
Instructions and file lists remain outside it; inherited opaque bases remain
uncapped and the minimum line budget remains 500 characters. Disabling the cap
still removes thinking and tool outputs and abbreviates tool-call signatures.
It may leave too much context for the model, particularly during overflow recovery.

With no interactive UI, `warn` emits a warning and applies the cap. TUI and
supported RPC clients can answer the dialogs. In interactive sessions, `warn`
can wait for an answer even during automatic compaction; use `/cap-compaction on`
for unattended operation. If a percentage cannot be resolved because the model's
context window is unavailable, compaction is cancelled: choose a character/token
budget or turn the cap off.

### Recover historical details

The extension registers a subagent lookup and three direct-search fallback tools:

| Tool | Purpose |
|---|---|
| `context_lookup` | Recover specific historical details from the full raw session branch. Accepts only `question`. |
| `context_list_entries` | Fallback: list entry ids, roles, timestamps, and previews. |
| `context_grep` | Fallback: regex-search the raw branch with surrounding lines and entry attribution. |
| `context_show_entry` | Fallback: retrieve an entry by id. |

For example, ask the agent to recover the build error observed before compaction.
It can call `context_lookup` with:

```json
{
  "question": "What exact build error did we observe for src/auth.ts before compaction? Include the ENTRY id and observed tool output."
}
```

The subagent searches in its own context and returns findings with entry
references. Its raw search results stay out of the main conversation. If findings
are incomplete, the fallback tools run the same searches directly; their results
enter the main context. Turn-limit write-ups include a note recommending these
tools for further detail on the same query, even if the write-up fails.

By default, only one `context_lookup` attempt is allowed until a user message,
a bash execution, or a tool result outside these four recovery tools resets the
limit. Fallback searches, assistant text, and thinking neither increase nor reset
the count. Pending lookup calls in the same batch also count, preventing parallel
calls from bypassing the limit. Blocked attempts return a short fallback note
without launching a subagent; later lookups after other work remain available.

Search responses are bounded pages, not necessarily complete entries or match
lists. Follow all reported continuation parameters, keeping other search
parameters unchanged. Listing and grep cursors include `throughEntry` to keep
newly appended calls/results from expanding the search while paging. The raw
history remains complete; oversized entries and individual lines remain
accessible across pages.

After compaction, the checkpoint instructs the agent to re-read required documents,
even if previously read, re-acquire missing task information, inspect Git state
when in a Git repository, and re-read files before modifying them.

## Configuration

No separate configuration file is required. Set environment variables before
starting Pi:

| Variable | Default | Meaning |
|---|---|---|
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | Unset (uses percentage budget) | Initial conversation-section character budget override; takes precedence over the percentage setting. |
| `MECH_COMPACT_MAX_SUMMARY_PERCENT` | `25` | Initial percentage of the model's context window, using estimated tokens. Accepts numbers greater than 0 and at most 100, including decimals; invalid values fall back to 25. |
| `MECH_COMPACT_LOOKUP_MODEL` | Session model | Optional `provider/modelId` for lookups; must support tool calls and be available in Pi. An unresolved model falls back to the session model. |
| `MECH_COMPACT_LOOKUP_TURNS` | `10` | Maximum substantive search turns. Valid continuation-only turns are exempt; total search-phase model calls are capped at 3× this budget (30 by default), plus one tool-free write-up on exhaustion. |
| `MECH_COMPACT_LOOKUP_MAX_CALLS` | `1` | Maximum consecutive lookup attempts. `0` means unlimited; see [recovery reset rules](#recover-historical-details). Invalid values fall back to 1. |
| `MECH_COMPACT_LOOKUP_SESSION_FILE` | Unset | Optional absolute path to a full session JSONL, replacing the current branch as the lookup source. Intended for harnesses using pruned forks. |

Cap-budget precedence is **session setting → explicit character setting → percentage setting**.
The initial cap mode remains `warn`.

For a different percentage default, with the character override unset:

```bash
MECH_COMPACT_MAX_SUMMARY_PERCENT=30 pi
```

Or use a fixed character budget:

```bash
MECH_COMPACT_MAX_SUMMARY_CHARS=40000 pi
```

The lookup model, turn budget, consecutive-call limit, and initial cap settings are read when the extension loads.
Use `/cap-compaction` to change the session budget or mode without restarting. The
session-file override is checked at each lookup. Restart Pi after changing its
launching environment; `/reload` does not change inherited environment variables.
The extension does not automatically load `.env` files.

Leave the session-file override unset for ordinary use. When configured, lookup
opens that file with `SessionManager.open()` and renders its branch. Relative,
missing, empty, or invalid source files fail explicitly rather than silently
searching the pruned fork. Opening a legacy file may trigger Pi's normal session
migration. The override is extension configuration, not a tool argument or a
filesystem search route for the main agent.

The character budget is not a token limit or a hard cap on the whole checkpoint.
Instructions and file lists sit outside the conversation section; an inherited
base is uncapped and the line budget has a 500-character minimum. Tune it
alongside the model's context window and Pi's `compaction.keepRecentTokens`.
[Design details](docs/design.md).

### Local inference engines

When lookups use the session model on a local server, they share its KV cache with the main session.

- **llama.cpp**: on a single-slot server (`-np 1`), each lookup call evicts the main session's KV cache. Enable host-memory prompt caching with `--cache-ram <MiB>`, sized to hold at least one full main-session state, so the main session resumes in seconds instead of re-processing its entire context.
- **Other engines**: make sure the main session's prefix survives lookup calls, via prefix caching (on by default in vLLM and SGLang), host-RAM KV offloading where available, or enough parallel capacity to keep both sessions resident. Engines without these will re-prefill the main session after every lookup.

## How it works

### Deterministic checkpoint

Pi selects the compacted messages and retained boundary. In verbatim mode, the
extension builds a checkpoint without changing that boundary or calling a model:

| Content | Treatment |
|---|---|
| User messages | Kept verbatim, subject to the size guard. |
| Assistant prose | Kept, subject to the size guard. |
| Tool calls | Compact signatures with truncated arguments. Full arguments remain in the session. |
| Assistant thinking | Removed from the checkpoint; retained in the raw session. |
| Tool outputs | Removed from the checkpoint; retained in the raw session. |
| Recent conversation | Pi keeps its normal verbatim tail. |
| Earlier compacted spans | Re-rendered chronologically, without repeated model summarization. |
| Inherited model/legacy summary | Kept once as an opaque base, when present. |
| Read/modified file lists | Carried forward, without file contents. |

A single re-orientation block tells the agent what was removed and what must be
verified before being relied on. A closing line identifies where Pi's retained
verbatim tail begins.

#### How cap trimming works

The default conversation-section budget is **25% of the model's context window**,
using estimated tokens, with a prompt before trimming. When trimming is approved
(or cap mode is `on`), **user messages are prioritized over other content**—it is
not simply a global oldest-first cutoff.

Across all compacted spans, the algorithm proceeds in three stages, stopping as
soon as the available line budget is satisfied:

1. **Remove non-user entries, oldest first.** Assistant prose, tool-call stubs,
   and other non-user entries are dropped before any user message is shortened.
   A newer assistant entry can therefore be removed while an older user message
   survives. These are whole rendered entries, not individual physical lines;
   an assistant prose entry can contain multiple paragraphs.
2. **Shorten long user messages, oldest first.** Each eligible message becomes
   the first 120 characters of its rendered `[User]: ...` entry (including the
   prefix), followed by a marker such as
   `…[truncated +1234 chars — use context_lookup]`. This happens only when the
   stub is shorter than the original, and each entry is shortened at most once
   per cap pass. It is a literal prefix, not a model-generated summary.
3. **Remove the oldest remaining entries if still over budget.** This last
   resort can remove user messages too, including shortened stubs. A fully
   dropped span is represented by a trimmed-for-size placeholder.

Only the rendered checkpoint is trimmed: full originals remain in the session
and the uncapped span details, recoverable through `context_lookup`. The setting
is a size guard, not a hard cap on the whole checkpoint; the budget scope and
exceptions described above still apply.


### Session-backed lookup

Pi normally saves append-only JSONL sessions under:

```text
~/.pi/agent/sessions/--<project-path>--/<timestamp>_<session-id>.jsonl
```

Compaction adds an entry; it does not delete earlier thinking, tool calls, or
tool results. At each lookup, the extension obtains the current branch through
`ctx.sessionManager.getBranch()`, **not** the compacted model-context projection.
Custom session locations work automatically. In-memory sessions work while the
process lives, but cannot be resumed after exit.

The raw branch is mechanically rendered **in memory** into readable transcript
lines. Blocks have `ENTRY` headers; assistant sections have `[thinking]`,
`[text]`, and `[toolCall]` markers. Thinking, tool arguments, and textual tool
outputs are preserved without truncation in that representation. An authoritative
entry/section index prevents header-like text inside output from spoofing
attribution.

The subagent uses three internal tools: `list_entries`, `grep`, and `show_entry`.
These search the rendered lines directly, so no temporary file, second session
copy, or cleanup is needed. They share the fallback tools' paginated search
functions. Individual results and the final answer have size limits. Follow
pages only when omitted content is needed, not to exhaust every match or entry.

Valid continuation-only turns do not spend the substantive search budget; new
queries, changed parameters, or replayed cursors do. A separate ceiling caps all
search-phase model calls at three times the configured turn budget (30 by default).
When either budget ends searching, one final tool-free model call writes up
partial findings; a failed write-up falls back to the latest text, explicitly
labeled incomplete. Lookup requests use normal provider caching
defaults rather than forcing caching off; actual cache behavior and savings vary
by provider.

## Local-inference trade-offs

- Compaction uses CPU text processing instead of model inference, with no extra
  transcript write beyond Pi's normal session persistence.
- User messages and assistant prose are carried forward without model rewriting.
  Exact removed evidence remains available outside active context.
- Recovery inference is deferred until a lookup is requested and normally uses
  the same session model.
- A checkpoint still consumes context. A larger character budget retains more
  prose but increases subsequent prompt processing and context use.
- Lookups require inference and may take substantial time. Lower compaction
  latency does not imply lower total runtime for every workload.

With a local lookup model, transcript excerpts remain within the local workflow.
Selecting a remote lookup model sends those excerpts to its provider.

## Pilot results

A preliminary synthetic pilot used local **Qwen3.8-27B via llama.cpp**, ten
sessions, and three successive compactions:

| | After compaction 1 | After compaction 2 | After compaction 3 |
|---|---:|---:|---:|
| Pi default compaction recall | 83% | 79% | 79% |
| Pi default compaction confidently wrong answers | 6 | 13 | 14 |
| verbatim-compact recall | 97% | 99% | 99% |
| verbatim-compact confidently wrong answers | 0 | 1 | 0 |

Median compaction time was **0.8–1.1 seconds** for verbatim-compact and
**204–372 seconds** for Pi's model summary. These timings exclude lookups.

**These historical results used a separate-dump lookup implementation**, not the
current session-backed implementation. They have not been re-measured for this
release and are not a general performance guarantee. A fuller evaluation is in
progress. [Details, examples, and scoring notes](docs/pilot-results.md).



## Limitations and safety

- Session history and lookup results can contain credentials, private code, and
  conversation details. Do not commit or share them without review. A remote
  lookup model receives the excerpts provided to the subagent.
- Recovery can miss evidence or hit output/turn limits. Partial findings are
  labeled; they are not proof that every relevant fact was found.
- Images are noted but not inlined in the text transcript. Binary image data and
  some system/metadata fields remain only in Pi's session storage.
- Lookup is branch-scoped. It does not search history that was actually deleted
  or excluded from its source session.
- Branch summarization is unchanged: Pi still uses model-based `/tree` summaries.
- If checkpoint construction fails, Pi's normal compaction is used. A lookup
  failure reports an error without changing the compaction or session context.



## Development

```bash
npm ci --ignore-scripts
npm test
```

Tests use synthetic sessions and stubbed model responses, including raw recovery
across three compactions, branch scoping, override/error behavior, entry
attribution, size guards, pagination, and the bundled skill. Real Pi agent-turn
tests check tool-call persistence ordering, parallel-call limits, and recovery
reset rules. No live model, GPU, or credentials are required. The suite also
exercises Pi's real package and extension loaders and checks the packed resources.
See [contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE).
