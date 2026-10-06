---
name: context-retrieval
description: Recover earlier pi session context through the context_lookup subagent. Use after compaction when exact tool outputs, error text, file contents, thinking, tool-call arguments, or earlier instructions and decisions are needed. Use pi's retained session history for recovery, without creating additional snapshots.
---

# Session context recovery

This skill pairs with `verbatim-compact.ts`, which provides:

- **Verbatim compaction** — a deterministic checkpoint retains user messages, assistant prose, and compact tool-call signatures. Thinking and tool outputs are removed from the active model context, not from the raw session history. Earlier spans are re-rendered flat, with one re-orientation block and an opaque base when needed.
- **`context_lookup`** — a subagent searches the full raw session branch in its **own** context and returns only relevant findings. At lookup time, the extension mechanically renders the branch into entry-anchored text with an authoritative entry/section index, in memory. There is no local dump or temporary transcript file to manage.

Pi normally saves sessions under `~/.pi/agent/sessions/`; custom session locations also work. In-memory sessions retain history only while the process lives and cannot be resumed after exit. The extension does not register a snapshot tool or command.

If `context_lookup` is not in your tool list, say that subagent recovery is unavailable. Do not assume the extension is absent solely because `dump_context` is unavailable, and do not search session files manually as a fallback.

## When to use

- After a compaction, you need an exact error message, a full tool output, previously read file content, full tool-call arguments, an earlier instruction or decision, or reasoning that was dropped → call `context_lookup` with a **specific** question.
- A checkpoint or your memory contains a claim based on pre-compaction tool output → re-read the current source or ask `context_lookup` for the historical evidence before relying on the claim. If you cannot verify it, explicitly label it unverified.
- Before a long, tool-heavy task → no extra snapshot is required for recovery. Pi's raw session history already retains finalized entries. Follow the checkpoint's re-orientation instructions after compaction.

## How to ask

```text
context_lookup({ question: "What exact error did the earlier test run return for the N=7 case? Include the ENTRY id and observed tool output." })
```

Only supply `question`. Lookup covers all earlier compactions on the current branch automatically; there is no dump-selection argument. It does **not** search abandoned branches or unrelated sessions. If the detail is absent, report that limitation instead of claiming it was recovered or widening the search through filesystem tools.

A study harness may configure `MECH_COMPACT_LOOKUP_SESSION_FILE` to make the extension search a full session rather than a pruned fork. This is extension configuration, not a tool argument or a file the main agent should read. Do not discover or change the override to broaden a lookup.

## Rules

1. **Never grep or read session JSONL files or old context dumps in the main conversation for recovery.** Raw transcript text would refill the compacted context. Always use `context_lookup`.
2. Ask narrowly scoped questions using exact error strings, file paths, function names, or the command whose output you need. Recover tightly related details together; use separate queries for independent facts. Ask the subagent for evidence, not for a solution to the broader task.
3. Findings cite ENTRY ids and the logical transcript name. Retain these citations when relying on recovered facts. The renderer preserves full thinking, text, tool-call arguments, and tool results, although individual search results have output limits.
4. Distinguish **user instructions**, **observed tool output**, and **reasoning at the time**. A recovered `[thinking]` block is a historical hypothesis, not verified fact. Earlier assistant prose is not independently observed evidence either.
5. Historical tool output proves what was observed then, not what is true now. Re-read any file you are about to modify, review uncommitted work, and re-verify current build/test state as required by the checkpoint.
6. Lookups can return incomplete findings or fail. State what remains missing; do not invent details or treat a partial answer as exhaustive.

## Explicit snapshot requests

If the user asks to save/dump/snapshot context, explain that this extension uses pi's retained session history for recovery and provides no separate snapshot tool. Do not call `dump_context` or claim a new snapshot was saved. If the user needs an independent export, pi provides `/export`; review exports for sensitive content before sharing.

Session history and recovered findings can contain credentials, private code, and conversation details. Do not commit or share them without the user's explicit approval.
