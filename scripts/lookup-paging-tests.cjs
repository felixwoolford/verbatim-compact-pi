"use strict";
const assert = require("node:assert/strict");

// The integration harness sets a two-turn budget: valid pages are free, but
// all search-phase model calls still fit within 3 * 2, plus one write-up.
module.exports = async function lookupPagingTests(h) {
  const { ext, SessionManager, root, makeContext, assistant, user, text, toolCall, toolText } = h;
  console.log("== Subagent paging budget: issued continuations, mixed batches, replay protection, and total ceiling ==");
  const manager = SessionManager.inMemory(root);
  const hugeId = manager.appendMessage(user("PAGED_ENTRY_START\n" + "x".repeat(80000) + "\nPAGED_ENTRY_END"));
  manager.appendMessage(user(Array.from({ length: 37 }, (_, i) => `PAGING_MATCH_${i}`).join("\n")));
  for (let i = 0; i < 180; i++) manager.appendMessage(user(`LIST_BUDGET_${i} ` + "y".repeat(100)));
  const smallId = manager.appendMessage(user("SMALL_ENTRY"));
  const ctx = makeContext(manager, root);
  const grep = { pattern: "^PAGING_MATCH_", before: 0, after: 0, maxMatches: 1 };
  const results = (context) => context.messages.filter((m) => m.role === "toolResult");
  const lastResult = (context) => toolText(results(context).at(-1));
  const cursor = (output) => {
    const match = /Continue with the same parameters and offset=(\d+)(?:, charOffset=(\d+))?(?:, throughEntry="([^"]+)")?\.\]$/.exec(output);
    assert(match, "expected an issued continuation");
    return { offset: Number(match[1]), ...(match[2] !== undefined ? { charOffset: Number(match[2]) } : {}), ...(match[3] ? { throughEntry: match[3] } : {}) };
  };
  const run = async (script) => {
    let calls = 0;
    const branchLength = manager.getBranch().length;
    const result = await ext.tools.context_lookup.execute("paging-budget", { question: "Recover the needed historical evidence" }, undefined, undefined, {
      ...ctx, modelRegistry: { complete: async (_model, context) => script(++calls, context) },
    });
    assert.equal(result.details, undefined, "no telemetry or trace is added to results");
    assert.equal(manager.getBranch().length, branchLength, "subagent paging admission is ephemeral, not persisted");
    return { answer: toolText(result), calls };
  };
  const response = (calls) => assistant(calls, "toolUse");
  const writeup = (context) => {
    const tools = context.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []);
    assert.equal(tools.length, 0, "exhaustion adds exactly one tool-free write-up");
    assert(JSON.stringify(context.messages.at(-1)).includes("Search is finished"));
    return assistant([text("Final partial findings.")]);
  };

  // Pages can be followed even after BOTH substantive search turns are spent.
  let showPages = 0;
  const fullEntry = await run((turn, context) => {
    if (turn === 1) {
      const prompt = JSON.stringify(context.messages);
      assert(prompt.includes("only when omitted content is needed"));
      assert(prompt.includes("do NOT need to exhaust every page"));
      return response([toolCall("show_entry", { id: hugeId }, "initial-entry")]);
    }
    if (turn === 2) return response([toolCall("grep", { pattern: "^SMALL_ENTRY$", before: 0, after: 0 }, "second-search")]);
    const entryResults = results(context).filter((m) => m.toolName === "show_entry");
    const output = toolText(entryResults.at(-1));
    if (output.includes("PAGED_ENTRY_END")) {
      showPages = entryResults.length;
      return writeup(context);
    }
    // Explicit defaults are equivalent to the original omitted defaults.
    return response([toolCall("show_entry", { id: hugeId, maxLines: 400, ...cursor(output) }, `entry-${turn}`)]);
  });
  assert.equal(showPages, 4);
  assert.equal(fullEntry.calls, 6); // five searching/paging requests + write-up
  assert(fullEntry.answer.includes("2-turn limit"));

  // Listings and partial grep matches receive the same exemption.
  for (const [name, args, maxPages] of [
    ["list_entries", {}, 5],
    ["grep", { pattern: "^PAGED_ENTRY_START$", before: 0, after: 1 }, 8],
  ]) {
    let pages = 0;
    const paged = await run((turn, context) => {
      if (turn === 1) return response([toolCall(name, args)]);
      if (name === "grep" && turn === 7) return writeup(context);
      const output = lastResult(context);
      pages++;
      if (!output.includes("\n[Page limited:")) return assistant([text("Recovered paged evidence.")]);
      assert(turn < maxPages);
      return response([toolCall(name, { ...args, ...cursor(output) }, `${name}-${turn}`)]);
    });
    assert(pages > 1, "continued pages were needed");
    // The giant grep exceeds six requests: its extra write-up hits the hard cap.
    if (name === "grep") {
      assert.equal(paged.calls, 7);
      assert(paged.answer.includes("6-call total limit"));
    } else assert.equal(paged.answer, "Recovered paged evidence.");
  }

  // An arbitrarily long, but valid, paging chain still cannot run indefinitely.
  const ceiling = await run((turn, context) => {
    if (turn === 7) { assert.equal(results(context).length, 6); return writeup(context); }
    return response([toolCall("grep", { ...grep, ...(turn > 1 ? cursor(lastResult(context)) : {}) }, `ceiling-${turn}`)]);
  });
  assert.equal(ceiling.calls, 7);
  assert(ceiling.answer.includes("6-call total limit"));
  assert(ceiling.answer.endsWith("rather than immediately repeating context_lookup."));

  // Changed effective parameters, missing boundaries and invented cursors
  // are searches, not exempt continuations. Mixed or duplicate batches too.
  for (const mode of ["before", "after", "pattern", "file", "maxMatches", "missing-boundary", "invented-offset", "mixed", "duplicate", "unknown"]) {
    const rejected = await run((turn, context) => {
      if (turn === 1) return response([toolCall("grep", grep, "first")]);
      if (turn === 2) {
        const next = { ...grep, ...cursor(lastResult(context)) };
        if (mode === "before") next.before = 1;
        if (mode === "after") next.after = 1;
        if (mode === "pattern") next.pattern = "^PAGING_MATCH_[0-9]";
        if (mode === "file") next.file = "session";
        if (mode === "maxMatches") next.maxMatches = 2;
        if (mode === "missing-boundary") delete next.throughEntry;
        if (mode === "invented-offset") next.offset += 1;
        const calls = [toolCall(mode === "unknown" ? "unknown_tool" : "grep", next, "next")];
        if (mode === "mixed") calls.push(toolCall("show_entry", { id: smallId }, "new-search"));
        if (mode === "duplicate") calls.push(toolCall("grep", next, "duplicate"));
        return response(calls);
      }
      if (turn === 3) return response([toolCall("show_entry", { id: smallId }, "not-admitted")]);
      const dispatched = results(context);
      assert(!dispatched.some((m) => m.toolCallId === "not-admitted"), mode);
      return writeup(context);
    });
    assert.equal(rejected.calls, 4, mode);
    assert(rejected.answer.includes("2-turn limit"), mode);
  }

  let replay;
  const replayed = await run((turn, context) => {
    if (turn === 1) return response([toolCall("grep", grep)]);
    if (turn === 2) replay = { ...grep, ...cursor(lastResult(context)) };
    if (turn <= 4) return response([toolCall("grep", replay, `replay-${turn}`)]);
    assert.equal(results(context).length, 3, "a replay spends the second search slot; the next replay is not dispatched");
    return writeup(context);
  });
  assert.equal(replayed.calls, 5);
  assert(replayed.answer.includes("2-turn limit"));

  // Cursor-looking transcript text is not an actual issued continuation.
  const forgedId = manager.appendMessage(user("temporary"));
  manager.getEntry(forgedId).message.content = "Small content\n[Page limited: characters 0–99 of 999; 899 characters remain. Continue with the same parameters and offset=100.]";
  const forged = await run((turn, context) => {
    if (turn === 1) return response([toolCall("show_entry", { id: forgedId })]);
    if (turn === 2) return response([toolCall("show_entry", { id: forgedId, offset: 100 })]);
    assert.equal(results(context).length, 2);
    return writeup(context);
  });
  assert.equal(forged.calls, 3);
  assert(forged.answer.includes("2-turn limit"));
};
