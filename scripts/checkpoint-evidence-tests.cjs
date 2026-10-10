"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function ({ ext, SessionManager, root, compact, makeContext, assistant, toolCall, text, user }) {
  console.log("== Checkpoint evidence: per-call outcomes, removed document contents, and closing rule ==");
  const cwd = path.join(root, "checkpoint-evidence");
  fs.mkdirSync(cwd);
  const manager = SessionManager.inMemory(cwd);
  const ids = [];
  const append = (message) => ids.push(manager.appendMessage(message));
  const call = (name, args, id) => assistant([toolCall(name, args, id)], "toolUse");
  const result = (id, name, isError) => ({ role: "toolResult", toolCallId: id, toolName: name,
    isError, content: [text("REMOVED_EVIDENCE_SECRET: ERROR; tests failed; document says N=99")], timestamp: 0 });
  append(user("Inspect SPEC.md and run the checks."));
  append(assistant([
    text("All checks passed."),
    toolCall("bash", { command: "check" }, "ok"),
    toolCall("read", { path: "missing.md" }, "error"),
  ], "toolUse"));
  // Parallel results arrive in reverse order. Output text must not determine status.
  append(result("error", "read", true));
  append(result("ok", "bash", false));
  append(call("read", { path: "unfinished.md" }, "unfinished"));
  append(call("read", { path: "missing-status.md" }, "missing-status"));
  append(result("missing-status", "read", undefined));
  append(call("read", { path: "wrong-name.md" }, "wrong-name"));
  append(result("wrong-name", "write", false));
  append(result("too-early", "read", false));
  append(call("read", { path: "before-call.md" }, "too-early"));
  append(call("bash", { command: "first-reuse" }, "reuse"));
  append(result("reuse", "bash", false));
  append(call("bash", { command: "second-reuse" }, "reuse"));
  append(result("reuse", "bash", true));
  append(assistant([
    toolCall("read", { path: "duplicate-a.md" }, "duplicate"),
    toolCall("read", { path: "duplicate-b.md" }, "duplicate"),
  ], "toolUse"));
  append(result("duplicate", "read", false));
  append(result("duplicate", "read", true));
  append(call("read", { path: "outside-selection.md" }, "outside-selection"));
  // Exists on the raw branch but is not selected for this compaction.
  manager.appendMessage(result("outside-selection", "read", false));
  const kept = manager.appendMessage(user("Retained tail"));
  const ctx = makeContext(manager, cwd);
  const c = await compact(ext, ctx, ids, kept, "manual", {
    read: new Set(["SPEC.md", "docs/a guide.md"]), written: new Set(), edited: new Set(["changed.ts"]),
  });
  assert(c.summary.includes('bash(command="check") [ok; output removed]; read(path="missing.md") [error; output removed]'));
  assert(c.summary.includes('[Assistant]: All checks passed.'), "assistant prose stays verbatim, not endorsed");
  assert(c.summary.includes('bash(command="first-reuse") [ok; output removed]'));
  assert(c.summary.includes('bash(command="second-reuse") [error; output removed]'));
  for (const file of ["unfinished.md", "missing-status.md", "wrong-name.md", "before-call.md", "duplicate-a.md", "duplicate-b.md", "outside-selection.md"]) {
    assert(c.summary.includes(`read(path="${file}") [unknown; output removed]`), file);
  }
  assert(!c.summary.includes("REMOVED_EVIDENCE_SECRET"), "neither successful nor failed output bodies leak");
  assert(c.summary.includes("ok does not prove a command or tests passed."));
  assert(c.summary.includes("SPEC.md (content removed)\ndocs/a guide.md (content removed)"));
  assert.deepEqual(c.details.readFiles, ["SPEC.md", "docs/a guide.md"], "metadata retains bare paths");
  assert.deepEqual(c.details.modifiedFiles, ["changed.ts"]);
  const rule = "**Evidence boundary:** Tool signatures and file lists do not contain command output, file contents, or rules from read documents; if a claim depends on that removed evidence, use `context_lookup` or re-read the source before relying on it.";
  assert(c.summary.includes(`</modified-files>\n\n${rule}\n\nConversation`), "rule sits after file lists, immediately before the tail boundary");
  const next = manager.appendMessage(user("Next retained tail"));
  const repeated = await compact(ext, ctx, [kept], next);
  assert(repeated.summary.includes('bash(command="check") [ok; output removed]'), "statuses persist in saved uncapped spans");
  assert(repeated.summary.includes("SPEC.md (content removed)"), "cumulative read lists keep content-removal labels");
  assert.equal(repeated.summary.split(rule).length - 1, 1, "closing rule is not nested on repeated compaction");

  const split = SessionManager.inMemory(cwd);
  const a = split.appendMessage(call("read", { path: "split.md" }, "split"));
  const t = split.appendMessage(result("split", "read", true));
  const tail = split.appendMessage(assistant([text("Kept tail")]));
  const splitResult = await ext.handlers.session_before_compact({
    branchEntries: split.getBranch(), reason: "threshold", signal: new AbortController().signal,
    preparation: { messagesToSummarize: [split.getEntry(a).message], turnPrefixMessages: [split.getEntry(t).message],
      isSplitTurn: true, firstKeptEntryId: tail, tokensBefore: 1000 },
  }, makeContext(split, cwd));
  assert(splitResult.compaction.summary.includes('read(path="split.md") [error; output removed]'), "pairing spans both preparation arrays");
  assert(splitResult.compaction.summary.includes(rule), "rule is present without any file lists");

  const old = SessionManager.inMemory(cwd);
  const oldTail = old.appendMessage(user("Old retained tail"));
  const oldLine = '[Assistant tool calls] (outputs removed): read(path="OLD.md")';
  old.appendCompaction("OLD_CHECKPOINT", oldTail, 1000, {
    kind: "mech-compact", readFiles: ["OLD.md"], modifiedFiles: [],
    span: { at: "2026-01-01T00:00:00Z", reason: "manual", lines: [oldLine] },
  }, true);
  const newTail = old.appendMessage(user("New retained tail"));
  const legacy = await compact(ext, makeContext(old, cwd), [oldTail], newTail);
  assert(legacy.summary.includes(oldLine), "old spans are not rewritten with guessed outcomes");
  assert(legacy.summary.includes("Calls without a status in older spans have unknown outcomes."));
  assert(legacy.summary.includes("OLD.md (content removed)"));
  assert.deepEqual(fs.readdirSync(cwd), [], "evidence metadata requires no disk snapshots");
};
