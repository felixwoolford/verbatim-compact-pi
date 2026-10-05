# verbatim-compact

Deterministic context compaction for [Pi](https://pi.dev/). Replaces the
model-generated compaction summary with a checkpoint built from conversation
text. Thinking and tool outputs are removed from active context but preserved
in local transcript dumps, with a subagent tool for recovery.

The intended use case is local inference: for example, **Qwen 3.8 27B through
llama.cpp on an RTX 5090**. Compaction itself makes no model call. Recovery uses
the session model by default and does not require a second model to be loaded.

## Install

Requires Pi and Node.js 22.19 or newer. The tests currently target **Pi 1.0.3**;
other versions have not been verified here.

### Package installation

From a downloaded or cloned checkout:

```bash
pi install /absolute/path/to/verbatim-compact
```

This installs both the extension and the `context-retrieval` skill. Run `/reload`
in an existing Pi session, or restart Pi.

Once the GitHub repository and release tag exist, install directly with the
following command, replacing `OWNER` and the tag:

```bash
pi install git:github.com/OWNER/verbatim-compact@v0.1.0
```

Use `pi install --local <source>` for a project-only installation. To load a
local checkout for one invocation without saving an installation:

```bash
pi -e /absolute/path/to/verbatim-compact
```

Remove any previously copied extension and skill before installing the package,
so only one copy loads.

### Manual installation

From the checkout directory:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp verbatim-compact.ts ~/.pi/agent/extensions/
cp -r context-retrieval ~/.pi/agent/skills/
```

Then `/reload`. Project equivalents are `.pi/extensions/` and `.pi/skills/`.

Add `.pi/context-dumps/` to the working project's `.gitignore`. Dumps can contain
credentials, private code, and conversation history. As a backstop, the
extension warns (once per session, per dump location) when it writes a dump
into a git worktree whose ignore rules don't cover it. See
[Configuration](#configuration) for `MECH_COMPACT_DUMP_DIR`, which moves dumps
outside the project entirely.

## Usage

Pi's automatic compaction uses verbatim-compact once the extension is loaded.
Manual compaction and snapshots use these commands:

```text
/compact
/dump-context before-refactor
```

`/dump-context` writes a snapshot without compacting. `/compact` works even if
Pi's automatic compaction is disabled.

The extension registers two model-callable tools:

| Tool | Purpose |
|---|---|
| `dump_context` | Snapshot the current branch without compacting. Accepts an optional `note`. |
| `context_lookup` | Recover specific details from transcript dumps. Accepts a `question` and optional `dumpDir`. |

For example, ask the agent to recover the build error observed before compaction.
It can call `context_lookup` with:

```json
{
  "question": "What exact build error did we observe for src/auth.ts before compaction?"
}
```

The subagent searches in its own context and returns findings with entry
references. It does not return the whole transcript to the main agent.

Use one narrowly scoped information need per lookup. Recover independent missing
facts separately, then integrate the findings in the main conversation. The
bundled skill explains this workflow. To load it explicitly:

```text
/skill:context-retrieval
```

The default lookup target already contains the branch's full history. Use
`dumpDir: "all"` when evidence may be on an abandoned branch; an explicit dump
directory name or absolute path selects a particular dump.

After compaction, the checkpoint instructs the agent to re-run project startup
checks, inspect Git state, and re-read files before modifying them. Recovered
outputs describe past state, not necessarily current source or test state.

## Behavior

Before replacing the active context, the extension writes the current branch to:

```text
.pi/context-dumps/<timestamp>_<id>/
  conversation.md   transcript with entry headers, thinking, and tool outputs
  meta.json         entry/line index, session information, and compaction metadata
```

The checkpoint retains the following:

| Content | Treatment |
|---|---|
| User messages | Kept verbatim, subject to the size guard. |
| Assistant prose | Kept, subject to the size guard. |
| Tool calls | Compact signatures with truncated arguments. |
| Assistant thinking | Removed from active context; preserved in dumps. |
| Tool outputs | Removed from active context; preserved in dumps. |
| Recent conversation | Pi keeps its normal verbatim tail. |

Earlier spans are rendered chronologically, without repeated model
summarization. The default conversation-section budget is **80,000 characters**.
When it fills, the oldest non-user content is removed first; oversized user
messages can then be shortened or removed. Original dumped text remains
available for lookup.

Each dump covers the whole current branch. Older dumps are pruned only when
every indexed entry is present in the new dump. Dumps of abandoned branches are
retained. Ordinary lookups are scoped by shared session entry IDs; forks can
therefore access their parent history.

The defining property of verbatim-compact is the guarantee that all history is either kept
verbatim in context or stripped entirely from it; nothing is ever compressed in
between. Every compaction is also followed by a re-orientation block that tells the agent what was removed and that the remaining information must be verified before being relied on.

## Local-inference trade-offs

On a consumer GPU setup such as a 5090 running a local 27B model:

- Compaction uses CPU text processing and disk I/O instead of GPU inference.
- User messages and assistant prose are carried forward without a model rewriting
  earlier summaries. Exact tool outputs remain available outside active context.
- Model inference for recovery is deferred until a lookup is requested. The
  default lookup runs on the same session model.
- A compacted checkpoint still consumes context. Increasing the character budget
  retains more prose but increases subsequent prompt processing and context use.
- Lookups require inference and may take substantial time. Lower compaction
  latency does not imply lower total runtime for every workload.

With a local lookup model, transcript excerpts remain within the local workflow.
Selecting a remote lookup model sends those excerpts to its provider.

## Pilot results

A synthetic debugging pilot used local **Qwen3.8-27B via llama.cpp**, ten
sessions, and three successive compactions:

| | After compaction 1 | After compaction 2 | After compaction 3 |
|---|---:|---:|---:|
| Pi model-summary recall | 83% | 79% | 79% |
| verbatim-compact recall | 97% | 99% | 99% |
| Pi confident wrong answers | 6 | 13 | 14 |
| verbatim-compact confident wrong answers | 0 | 1 | 0 |

Median compaction time was **0.8–1.1 seconds** for verbatim-compact and
**204–372 seconds** for Pi's model summary. These timings exclude lookups,
which still require model inference.

The pilot illustrates behavior under repeated compaction, not a general
performance guarantee. A fuller evaluation is in progress.
[Details, examples, and scoring notes](docs/pilot-results.md).

## Configuration

No separate configuration file is required. Set environment variables before
starting Pi:

| Variable | Default | Meaning |
|---|---|---|
| `MECH_COMPACT_MAX_SUMMARY_CHARS` | `80000` | Conversation-section character budget. |
| `MECH_COMPACT_LOOKUP_MODEL` | Session model | Optional `provider/modelId` for lookups. Must support tool calls and be available in Pi. |
| `MECH_COMPACT_LOOKUP_TURNS` | `10` | Maximum search turns; exhaustion adds one final tool-free write-up call. |
| `MECH_COMPACT_DUMP_DIR` | `<project>/.pi/context-dumps` | Absolute path that replaces the per-project dump root. Use it to keep dumps out of versioned trees (e.g. `~/.pi/context-dumps`). Relative values are ignored with a warning. Session scoping and pruning still apply; dumps of different projects in a shared root are kept separate by session ownership. |
| `MECH_COMPACT_WARN_GITIGNORE` | `on` | Warn once per session when a dump is written into a git worktree that doesn't ignore the dump location. Set `0` (or `off`/`no`/`false`) to silence it. |

For a smaller checkpoint:

```bash
MECH_COMPACT_MAX_SUMMARY_CHARS=40000 pi
```

To persist settings, add exports to your shell profile:

```bash
export MECH_COMPACT_MAX_SUMMARY_CHARS=80000
export MECH_COMPACT_LOOKUP_TURNS=10
```

Settings are read when the extension loads. Restart Pi after changing its
launching environment; `/reload` alone does not change the running process's
inherited environment. The extension does not automatically load `.env` files.

The character budget is not a token limit or a hard cap on the whole checkpoint.
Instructions, file lists, tag overhead, and an uncapped inherited model/legacy
summary can add to it. Tune it alongside the model's context window and Pi's
`compaction.keepRecentTokens`. [Design details](docs/design.md).

## Limitations and safety

- Dumps are sensitive local files, not encrypted backups. Do not commit or share
  them without review. Writing a dump into a git worktree that doesn't ignore
  the dump location produces a one-time warning (`MECH_COMPACT_WARN_GITIGNORE=0`
  silences it); set `MECH_COMPACT_DUMP_DIR` to move dumps out of the tree if
  you can't ignore them.
- Recovery can miss evidence or hit the turn limit. Partial findings are labeled.
  Recovered thinking is historical reasoning, not verified fact.
- Images are noted but not inlined in the Markdown dump. Image data remains in
  Pi's session storage.
- Branch summarization is unchanged: Pi still uses model-based `/tree` summaries.
- If dumping or checkpoint construction fails, Pi's normal compaction is used.

To uninstall a package, use `pi remove <the-source-you-installed>` and `/reload`.
For manual installation, remove the copied extension and skill, then `/reload`.
Existing dumps remain on disk.

## Development

```bash
npm ci --ignore-scripts
npm test
```

Tests use synthetic sessions and stubbed model responses. No live model, GPU, or
credentials are required. They also exercise Pi's real package and extension
loaders. See [contributing](CONTRIBUTING.md) and the
[release checklist](docs/releasing.md).

## License

[MIT](LICENSE).
