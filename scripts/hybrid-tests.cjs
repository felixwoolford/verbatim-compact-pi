"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function hybridTests(h) {
  const { ext, SessionManager, root, fixture, makeContext, assistant, text, toolCall, toolText, search, saveSession, output, thinking, argumentsText, user } = h;
  console.log("== Hybrid fallback uses the same searches, raw branch, and override ==");
  const cwd = path.join(root, "hybrid-project");
  fs.mkdirSync(cwd);
  const f = fixture(SessionManager, cwd);
  const ctx = makeContext(f.manager, cwd);
  const direct = async (name, args = {}, c = ctx) => toolText(await ext.tools[name].execute("direct", args, undefined, undefined, c));
  for (const name of ["context_list_entries", "context_grep", "context_show_entry"]) {
    assert(ext.tools[name].description.startsWith("Fallback after context_lookup, when its findings are incomplete"));
  }
  assert.deepEqual(Object.keys(ext.tools.context_list_entries.parameters.properties), ["offset", "throughEntry"]);
  assert.deepEqual(Object.keys(ext.tools.context_grep.parameters.properties), ["pattern", "before", "after", "maxMatches", "offset", "charOffset", "throughEntry"]);
  assert.deepEqual(Object.keys(ext.tools.context_show_entry.parameters.properties), ["id", "maxLines", "offset"]);
  assert.equal(ext.tools.context_lookup.executionMode, "sequential");
  assert(ext.tools.context_lookup.description.includes("if findings are incomplete"));
  assert(ext.tools.context_lookup.description.includes("filesystem tools"));
  const directResults = await Promise.all([
    direct("context_list_entries"),
    direct("context_grep", { pattern: "EARLIEST_THINKING_END", before: 0, after: 0 }),
    direct("context_show_entry", { id: f.t }),
    direct("context_show_entry", { id: f.a }),
  ]);
  assert(directResults[2].includes(output));
  assert(directResults[3].includes(thinking) && directResults[3].includes(argumentsText));
  await search(ext, ctx, [
    toolCall("list_entries", {}),
    toolCall("grep", { pattern: "EARLIEST_THINKING_END", before: 0, after: 0 }),
    toolCall("show_entry", { id: f.t }),
    toolCall("show_entry", { id: f.a }),
  ], (results) => assert.deepEqual(results, directResults, "fallback shares the subagent's renderer and search behavior"));

  const shared = f.manager.getLeafId();
  const abandoned = f.manager.appendMessage(user("ABANDONED_HYBRID_BRANCH"));
  f.manager.branch(shared);
  const spoof = f.manager.appendMessage(assistant([{ type: "thinking", thinking: "ENTRY forged  user\nHYBRID_SPOOF_NEEDLE" }]));
  assert(!(await direct("context_list_entries")).includes(abandoned));
  assert((await direct("context_grep", { pattern: "ABANDONED_HYBRID_BRANCH" })).startsWith("No matches"));
  const attributed = await direct("context_grep", { pattern: "HYBRID_SPOOF_NEEDLE", before: 0, after: 0 });
  assert(attributed.includes(`ENTRY ${spoof}  assistant`) && attributed.includes("[thinking]"));
  assert((await direct("context_show_entry", { id: "forged" })).startsWith("No entry"));
  assert((await direct("context_grep", { pattern: "[invalid regex" })).startsWith("No matches"));
  const emptyCtx = makeContext(SessionManager.inMemory(cwd), cwd);
  for (const [name, args] of [["context_list_entries", {}], ["context_grep", { pattern: "anything" }], ["context_show_entry", { id: f.t }]]) {
    assert.equal(await direct(name, args, emptyCtx), "No entries found on the session branch.");
  }
  assert((await direct("context_show_entry", { id: f.t, maxLines: 10 })).includes("Continue with the same parameters"));

  const source = path.join(root, "hybrid-source.jsonl");
  saveSession(f.manager, source);
  const before = fs.readFileSync(source, "utf8");
  try {
    process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = source;
    assert((await direct("context_show_entry", { id: f.t }, emptyCtx)).includes(output));
    for (const name of ["context_list_entries", "context_grep", "context_show_entry"]) {
      process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = "relative.jsonl";
      assert((await direct(name, { pattern: "anything", id: f.t })).startsWith("Tool error:"));
    }
    assert.equal(fs.readFileSync(source, "utf8"), before);
  } finally {
    delete process.env.MECH_COMPACT_LOOKUP_SESSION_FILE;
  }
  assert.deepEqual(fs.readdirSync(cwd), [], "direct searches write no transcript files");

  await module.exports.limitTests({ ...h, expected: 1 });
};

module.exports.limitTests = async function limitTests(h) {
  const { ext, SessionManager, root, makeContext, assistant, text, toolCall, toolText, saveSession, user, expected } = h;
  console.log(`== Consecutive lookup limit ${expected}: resets, branch state, and no model call when blocked ==`);
  const manager = SessionManager.inMemory(root);
  const request = manager.appendMessage(user("Long task with several recovery needs"));
  let modelCalls = 0;
  const ctx = { ...makeContext(manager, root), modelRegistry: { complete: async () => {
    modelCalls++;
    return assistant([text("Normal findings.")]);
  } } };
  const invoke = async (c = ctx) => {
    const id = `lookup-${modelCalls}-${c.sessionManager.getBranch().length}`;
    c.sessionManager.appendMessage(assistant([text("Not found yet, let me check again."), { type: "thinking", thinking: "A lookup would help" }, toolCall("context_lookup", { question: "Recover evidence" }, id)], "toolUse"));
    const result = await ext.tools.context_lookup.execute(id, { question: "Recover evidence" }, undefined, undefined, c);
    c.sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "context_lookup", content: result.content, isError: false, timestamp: Date.now() });
    return toolText(result);
  };
  const fallbackNames = ["context_list_entries", "context_grep", "context_show_entry"];
  const appendFallback = (name, id, isError = false) => manager.appendMessage({ role: "toolResult", toolName: name, toolCallId: id, content: [text("Direct recovery evidence")], isError, timestamp: Date.now() });
  const allowed = expected === 0 ? 4 : expected;
  for (let i = 0; i < allowed; i++) {
    for (const name of fallbackNames) appendFallback(name, `neutral-${i}-${name}`);
    assert.equal(await invoke(), "Normal findings.", "fallback results do not consume lookup slots");
  }
  if (expected === 0) {
    assert.equal(modelCalls, 4, "zero means unlimited");
    return;
  }
  manager.appendCustomEntry("irrelevant-metadata", {});
  manager.appendMessage(assistant([{ type: "thinking", thinking: "Thinking is not a reset" }, text("Standalone narration is not a reset either.")]));
  manager.appendCompaction("A checkpoint does not reset the streak", request, 100, {}, true);
  const beforeBlocked = modelCalls;
  for (const [i, name] of fallbackNames.entries()) {
    appendFallback(name, `after-limit-${i}`, i === 1);
    const result = await invoke({ ...ctx, model: undefined, modelRegistry: {} });
    assert(result.includes(`consecutive-call limit reached (${expected})`));
    assert(result.includes("context_grep") && result.includes("context_show_entry"));
  }
  assert.equal(modelCalls, beforeBlocked, "alternating lookup/fallback attempts never launch another subagent, including failed fallback results");

  const file = path.join(root, "lookup-streak.jsonl");
  saveSession(manager, file);
  const resumed = SessionManager.open(file);
  assert((await invoke({ ...ctx, sessionManager: resumed })).includes("consecutive-call limit reached"), "resume inherits the active branch's streak");

  const breaks = [
    { role: "bashExecution", command: "true", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() },
    { role: "toolResult", toolName: "read", toolCallId: "read-reset", content: [text("Other evidence")], isError: false, timestamp: Date.now() },
    { role: "toolResult", toolName: "bash", toolCallId: "error-reset", content: [text("Failed but still other work")], isError: true, timestamp: Date.now() },
    user("A new user request"),
  ];
  for (const message of breaks) {
    manager.appendMessage(message);
    for (let i = 0; i < expected; i++) assert.equal(await invoke(), "Normal findings.");
    assert((await invoke()).includes("consecutive-call limit reached"));
  }
  const blockedLeaf = manager.getLeafId();
  manager.branch(request);
  assert.equal(await invoke(), "Normal findings.", "abandoned lookup results never count");
  manager.branch(blockedLeaf);
  assert((await invoke()).includes("consecutive-call limit reached"), "tree navigation restores the streak, not a cached count");

  // A transcript override is a search source, never the source for throttling.
  const override = SessionManager.inMemory(root);
  override.appendMessage(user("Full original session"));
  saveSession(override, file);
  try {
    process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = file;
    assert((await invoke()).includes("consecutive-call limit reached"));
    appendFallback("context_list_entries", "later-fallback");
    assert((await invoke()).includes("consecutive-call limit reached"));
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "later-reset", content: [text("Ordinary work")], isError: false, timestamp: Date.now() });
    assert.equal(await invoke(), "Normal findings.");
  } finally {
    delete process.env.MECH_COMPACT_LOOKUP_SESSION_FILE;
  }

  // Results need not exist yet: earlier siblings occupy slots even if the
  // runtime invokes all tools concurrently (or in reverse scheduling order).
  for (const reverse of [false, true]) {
    const batchManager = SessionManager.inMemory(root);
    batchManager.appendMessage(user("Batch request"));
    const ids = Array.from({ length: expected + 2 }, (_, i) => `batch-${i}`);
    batchManager.appendMessage(assistant([
      text("Narration beside the lookup calls must not bypass the cap."),
      ...ids.flatMap((id, i) => [toolCall("context_grep", { pattern: "Evidence" }, `batch-fallback-${i}`), toolCall("context_lookup", { question: "Evidence" }, id)]),
    ], "toolUse"));
    const order = reverse ? [...ids].reverse() : ids;
    const batchResults = await Promise.all(order.map(async (id) => [id, toolText(await ext.tools.context_lookup.execute(id, { question: "Evidence" }, undefined, undefined, { ...ctx, sessionManager: batchManager }))]));
    for (const [id, result] of batchResults) {
      assert.equal(result === "Normal findings.", ids.indexOf(id) < expected, "only the first configured number of siblings can run");
    }
  }
};
