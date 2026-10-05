---
name: context-retrieval
description: Save or recover pi session context. Use when the user asks to dump/save/snapshot the current context, when context was compacted and dropped details are needed (tool outputs, error text, file contents, thinking/decisions — recovered from .pi/context-dumps via the context_lookup subagent), or before long work that risks context overflow.
---

# Context dump & recovery

This skill pairs with the `verbatim-compact` extension, which provides:

- **Verbatim compaction** — when pi compacts (auto-compact or `/compact`), the model-generated summary is replaced by a deterministic checkpoint: user messages and assistant prose are kept, **thinking and tool outputs are removed**, and the full pre-compaction branch is dumped to `<project>/.pi/context-dumps/<timestamp>_<id>/` (`conversation.md` + `meta.json`). The checkpoint is flat: all earlier spans are re-rendered oldest-first inside `<compacted-span>` blocks (plus an opaque `<compacted-base>` block if the branch's most recent compaction without span details is a model summary or a legacy checkpoint), and the re-orientation block appears exactly once.
- **`dump_context` tool** — on-demand snapshot of the entire current context (thinking + full tool outputs) into a new dump directory, without compacting.
- **`context_lookup` tool** — a subagent that greps the dumps in its **own** context and returns only the relevant findings.

If these tools are not in your tool list, the `verbatim-compact` extension is not installed — say so to the user instead of grepping dumps manually.

## When to use

- The user asks to save / dump / snapshot the current context → call `dump_context` (with a short `note` describing why).
- A verbatim compaction checkpoint is in the conversation and you need a detail it dropped (exact error text, a tool output, file content you previously read, a decision or line of reasoning) → call `context_lookup` with a **specific** question.
- You are about to start a long, tool-heavy task that may overflow the context → call `dump_context` first so the current state is greppable afterwards.

## Rules

1. **Never grep `.pi/context-dumps/` in the main conversation.** Raw transcript text (and your reasoning about it) would pollute the compacted context. Always go through `context_lookup`.
2. Make `context_lookup` questions specific: include exact error strings, file paths, function names, or the command whose output you need. Each query should address one narrowly scoped information need; tightly related details can be recovered together. For independent missing facts, make separate queries, then integrate the findings in the main conversation. Ask the lookup subagent to recover evidence, not to solve the broader problem.
3. The subagent cites ENTRY ids and the dump file it found things in. If a finding matters for the work ahead, repeat the key fact in your own reply to the user.
4. The default lookup already covers the session's full history — each dump re-serializes the whole branch, and superseded dumps are pruned after each write. Only pass `dumpDir: "all"` if you suspect the detail lives on a branch abandoned via `/tree` (a dump of an abandoned branch survives pruning and uniquely preserves those). Lookups are scoped to the current session by entry-id overlap, so dumps from other sessions in the same project are ignored (an explicit directory name or absolute path still reaches any dump).

## What the dumps contain

- `conversation.md`: every session entry on the branch, full fidelity. Blocks start with `ENTRY <id> <role> <timestamp>` headers; entry ids match the session JSONL. Assistant entries show `[thinking]`, `[text]`, and `[toolCall]` sections; tool results are complete (untruncated).
- `meta.json`: session file path, cwd, token counts, cut point, why the dump was written, and a line index the lookup tools use (entry → start/end line, plus assistant section markers).
- Grep/lookup findings are attributed to their ENTRY and, for assistant entries, their section (`[thinking]` / `[text]` / `[toolCall]`). Treat recovered `[thinking]` as reasoning-at-the-time, not verified fact.

## Caveats

- Dumps are local and untracked. If the project is a git repo, `.pi/context-dumps/` belongs in `.gitignore`.
- Dumps contain whatever the conversation contained (secrets pasted in, tokens). Never commit or share them.
