/*
 * Self-contained integration test for verbatim-compact.ts
 *
 * Loads the extension through pi's jiti loader (same aliases pi's extension
 * loader uses) with a stub ExtensionAPI, then exercises:
 *   1. session_before_compact -> full dump + mechanical summary
 *   2. second compaction -> flat span re-rendering (n=1..2), file lists cumulative
 *   3. dump_context tool   -> on-demand dump
 *   4. context_lookup tool -> subagent loop (stubbed model) over the dump
 *   5. size guard          -> conversation section capped at MECH_COMPACT_MAX_SUMMARY_CHARS
 *   6. cap termination     -> capSpans cannot hang on huge user messages (regression)
 *   7. dump scoping        -> lookups only see the current session's dumps
 *   8. flat multi-span     -> 3 compactions: one header, spans n=1..3, tiling invariant
 *   9. legacy base         -> pre-span checkpoint renders as <compacted-base> exactly once
 *  10. model-summary base  -> non-mech compaction is the base; pre-base spans not re-rendered
 *  11. tree navigation     -> spans on abandoned branches are not rendered
 *  12. tag spoofing        -> user text containing span tags keeps the checkpoint usable
 *
 * Modes (argv[2]): full (default), cap (5+6), caphang (6 w/ 3000 budget),
 * capspans (cross-span cap with a tiny budget), dumpdir (MECH_COMPACT_DUMP_DIR).
 *
 * A synthetic session is generated, so the test is deterministic and does not
 * depend on any live session.
 *
 * Run:  node test.cjs            (needs the pi-coding-agent package resolvable)
 * Env:  PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent  (optional)
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// Locate Pi and its host-provided imports (local npm install or existing Pi).
// ---------------------------------------------------------------------------
const { piRoot, jitiAliases } = require("./scripts/pi-runtime.cjs");
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const jiti = createJiti(__filename, { alias: jitiAliases });

const EXT_PATH = path.join(__dirname, "verbatim-compact.ts");

function loadExt() {
  const handlers = {};
  const commands = {};
  const tools = {};
  const pi = {
    on: (name, h) => (handlers[name] = h),
    registerCommand: (name, def) => (commands[name] = def),
    registerTool: (def) => (tools[def.name] = def),
  };
  return { handlers, commands, tools, pi };
}

// ---------------------------------------------------------------------------
// Synthetic session
// ---------------------------------------------------------------------------
const MARKER_OUTPUT = `MARKER_TOOL_OUTPUT_START
` + "lorem ipsum dolor sit amet ".repeat(300) + // ~6.3k chars of distinctive tool output
`MARKER_TOOL_OUTPUT_END`;
const MARKER_THINKING = `MARKER_THINKING_START we must verify the edge case in parseFoo because ` + "the buffer overflows when N equals 7 ".repeat(20) + `MARKER_THINKING_END`;

function makeSessionFile() {
  const now = Date.now();
  const ts = (i) => new Date(now + i * 1000).toISOString();
  let i = 0;
  const e = (extra) => ({ id: `e${(i++).toString().padStart(4, "0")}`, parentId: null, timestamp: ts(i), ...extra });
  const entries = [
    { type: "session", version: 3, id: "synthetic-session", timestamp: ts(0), cwd: "/synthetic/project" },
    e({ type: "message", message: { role: "user", content: "Please fix the bug in foo.ts and make it robust.", timestamp: now } }),
    e({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: MARKER_THINKING },
          { type: "text", text: "Let me look at foo.ts first." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/foo.ts" } },
        ],
        api: "test",
        provider: "test",
        model: "test-model",
        stopReason: "toolUse",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 },
        timestamp: now + 1000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: MARKER_OUTPUT }],
        isError: false,
        timestamp: now + 2000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: MARKER_THINKING + " (round two)" },
          { type: "toolCall", id: "call_2", name: "edit", arguments: { path: "src/foo.ts", oldText: "a", newText: "b" } },
        ],
        api: "test",
        provider: "test",
        model: "test-model",
        stopReason: "toolUse",
        usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220 },
        timestamp: now + 3000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "edit",
        content: [{ type: "text", text: "Edited src/foo.ts (1 replacement)" }],
        isError: false,
        timestamp: now + 4000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Now add unit tests for foo.ts covering the N=7 case." }],
        timestamp: now + 5000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Tests for N=7 are next." },
          { type: "toolCall", id: "call_3", name: "bash", arguments: { command: "npm test -- --grep foo" } },
        ],
        api: "test",
        provider: "test",
        model: "test-model",
        stopReason: "toolUse",
        usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 330 },
        timestamp: now + 6000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_3",
        toolName: "bash",
        content: [{ type: "text", text: "PASS src/foo.test.ts\n  > parseFoo\n    ✓ handles N=7 (MARKER_TEST_OUTPUT)" }],
        isError: false,
        timestamp: now + 7000,
      },
    }),
    e({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "All tests pass. The fix handles the N=7 edge case." }],
        api: "test",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        usage: { input: 400, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 440 },
        timestamp: now + 8000,
      },
    }),
  ];
  // chain parentIds
  for (let k = 1; k < entries.length; k++) entries[k].parentId = entries[k - 1].id;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-session-")), "session.jsonl");
  fs.writeFileSync(file, entries.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  return { file, entries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function fullTest() {
  const mod = await jiti.import(EXT_PATH);
  const { handlers, commands, tools, pi } = loadExt();
  mod.default(pi);
  assert(handlers.session_before_compact, "hook registered");
  assert(commands["dump-context"], "command registered");
  assert(tools.dump_context, "dump_context tool registered");
  assert(tools.context_lookup, "context_lookup tool registered");

  const { file: sessionFile, entries } = makeSessionFile();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-test-"));
  const makeCtx = () => ({
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    ui: { notify: (msg, kind) => console.log(`  [notify${kind ? " " + kind : ""}] ${msg}`) },
    sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
    modelRegistry: {},
    model: undefined,
  });
  const msgEntries = entries.filter((x) => x.type === "message");

  // ---------------- Test 1: hook -> dump + mechanical summary ----------------
  console.log("\n== Test 1: session_before_compact ==");
  const summarizedEntries = msgEntries.slice(0, -3); // user1, asst1, tr1, asst2, tr2, user2
  const keptEntries = msgEntries.slice(-3); // asst3, tr3, asst4

  const preparation = {
    firstKeptEntryId: keptEntries[0].id,
    messagesToSummarize: summarizedEntries.map((x) => x.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123456,
    previousSummary: undefined,
    fileOps: { read: new Set(["src/foo.ts"]), written: new Set(), edited: new Set(["src/foo.ts", "src/foo.test.ts"]) },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const result = await handlers.session_before_compact(
    { type: "session_before_compact", preparation, branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
    makeCtx(),
  );
  assert(result && result.compaction, "hook returned a compaction");
  const { summary, firstKeptEntryId: fk, tokensBefore, details } = result.compaction;
  assert.strictEqual(fk, keptEntries[0].id);
  assert.strictEqual(tokensBefore, 123456);
  assert.strictEqual(details.kind, "mech-compact");
  assert(fs.existsSync(path.join(details.dumpDir, "conversation.md")), "dump conversation.md exists");
  const meta = JSON.parse(fs.readFileSync(path.join(details.dumpDir, "meta.json"), "utf8"));
  assert.strictEqual(meta.reason, "manual");
  assert.strictEqual(meta.sessionFile, sessionFile);

  const dumpText = fs.readFileSync(path.join(details.dumpDir, "conversation.md"), "utf8");
  assert(dumpText.includes(MARKER_OUTPUT), "dump contains FULL tool output (untruncated)");
  assert(dumpText.includes(MARKER_THINKING), "dump contains FULL thinking (untruncated)");

  // removed from the summary
  assert(!summary.includes("MARKER_TOOL_OUTPUT_START"), "summary has no tool output");
  assert(!summary.includes("MARKER_THINKING_START"), "summary has no thinking");
  // kept in the summary
  assert(summary.includes("Please fix the bug in foo.ts and make it robust."), "summary keeps user message 1 verbatim");
  assert(summary.includes("Now add unit tests for foo.ts covering the N=7 case."), "summary keeps user message 2 (array content) verbatim");
  assert(summary.includes("Let me look at foo.ts first."), "summary keeps assistant prose");
  assert(summary.includes("[Assistant tool calls] (outputs removed): read(path=\"src/foo.ts\")"), "summary keeps tool call signatures (outputs-removed label)");
  assert(summary.includes(path.join(details.dumpDir, "conversation.md")), "summary points at the dump");
  assert(summary.includes("context_lookup"), "summary directs to context_lookup");
  assert(summary.includes("Information removed from your active context is preserved in the transcript dump."), "summary distinguishes removal from loss");
  assert(summary.includes("recover relevant details, including earlier thinking and tool outputs"), "summary makes recoverable content explicit");
  assert(!summary.includes("can always be used to recover any information"), "summary does not guarantee lookup success");
  assert(tools.context_lookup.description.startsWith("Recover information preserved in transcript dumps but removed from your active context"), "tool description makes preservation explicit");
  assert(summary.includes("AGENTS.md"), "summary mentions AGENTS.md startup re-run");
  assert(
    summary.includes('<modified-files note="modified before compaction; current contents NOT in context">') && summary.includes("src/foo.ts"),
    "modified file list present (content-free note)",
  );
  // flat format
  assert(summary.includes("(compaction 1 on this branch)"), "header counts compactions on the branch");
  assert(summary.includes("<compacted-span n=\"1\""), "new span rendered as n=1");
  assert(!summary.includes("<compacted-base"), "no base block on a fresh branch");
  assert.strictEqual(summary.split("## Verbatim compaction checkpoint").length - 1, 1, "exactly one checkpoint header");
  assert.strictEqual(summary.split("Re-orient before continuing").length - 1, 1, "re-orientation block exactly once");
  assert(summary.includes("Redo the startup process described in the project instructions"), "step 1 says to redo the startup process (its text survives; the executed results don't)");
  assert(summary.includes("Re-read any file you are about to modify"), "re-orientation keeps the file re-read rule (step 3)");
  assert(summary.includes("Treat other pre-compaction knowledge as unverified too"), "re-orientation includes the unverified-knowledge rule (step 4)");
  assert(summary.includes("keepRecentTokens"), "header names the keepRecentTokens retained tail");
  // Boundary: closing line after the last span names the first kept entry's timestamp
  const keptEntryT1 = entries.find((e) => e.id === preparation.firstKeptEntryId);
  assert(
    summary.includes(`Conversation from ${keptEntryT1.timestamp} onward continues verbatim below — it was not compacted.`),
    "closing line names the first kept entry's time",
  );
  assert(
    summary.lastIndexOf("onward continues verbatim below") > summary.lastIndexOf("</compacted-span>"),
    "closing line comes after the last span",
  );
  // File lists describe the compacted spans, so they sit ABOVE the verbatim
  // boundary line, which is the last line of the checkpoint.
  assert(
    summary.lastIndexOf("</modified-files>") < summary.lastIndexOf("onward continues verbatim below"),
    "modified-files block precedes the verbatim boundary line",
  );
  assert(
    summary.endsWith(`Conversation from ${keptEntryT1.timestamp} onward continues verbatim below — it was not compacted.`),
    "closing line is the last line of the checkpoint",
  );
  // Span tag: compacted-at + covers, no bare at=
  const span1TagT1 = summary.match(/<compacted-span n="1"[^>]*>/)?.[0];
  assert(span1TagT1, "span 1 open tag found");
  assert(span1TagT1.includes("compacted-at=") && !span1TagT1.includes(" at="), "span tag uses compacted-at (no bare at=)");
  const spanFromIsoT1 = new Date(msgEntries[0].message.timestamp).toISOString();
  const spanToIsoT1 = new Date(summarizedEntries[summarizedEntries.length - 1].message.timestamp).toISOString();
  assert(span1TagT1.includes(`covers="${spanFromIsoT1} → ${spanToIsoT1}"`), "span covers range matches first/last summarised message timestamps");
  assert(details.span && Array.isArray(details.span.lines), "details.span stores this compaction's span lines");
  assert.strictEqual(details.span.from, spanFromIsoT1, "details.span.from stored");
  assert.strictEqual(details.span.to, spanToIsoT1, "details.span.to stored");
  console.log(`  OK — summary ${summary.length} chars, dump ${(dumpText.length / 1000).toFixed(1)}k chars`);

  // ---------------- Test 2: second compaction carries state ----------------
  console.log("\n== Test 2: second compaction carries previous state ==");
  const prep2 = {
    firstKeptEntryId: keptEntries[2].id,
    messagesToSummarize: keptEntries.slice(0, 2).map((x) => x.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 200000,
    previousSummary: summary,
    fileOps: { read: new Set(["docs/guide.md"]), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const entries2 = [
    ...entries,
    { type: "compaction", id: "cmp00001", parentId: entries[entries.length - 1].id, timestamp: new Date().toISOString(), summary, firstKeptEntryId: keptEntries[0].id, tokensBefore, details },
  ];
  const result2 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prep2, branchEntries: entries2, reason: "threshold", willRetry: false, signal: new AbortController().signal },
    makeCtx(),
  );
  assert(result2.compaction, "second compaction returned");
  // Extract the content of <compacted-span n="N">…</compacted-span>. (Lazy
  // match is fine here — the test content has no nested closing tags; the
  // spoofing case is covered by Test 12.)
  const spanBlock = (s, n) => (s.match(new RegExp(`<compacted-span n="${n}"[^>]*>\\n([\\s\\S]*?)\\n</compacted-span>`)) ?? [])[1] ?? null;
  const summary2 = result2.compaction.summary;
  assert.strictEqual(summary2.split("## Verbatim compaction checkpoint").length - 1, 1, "exactly one checkpoint header");
  assert(summary2.includes("(compaction 2 on this branch)"), "header counts 2 compactions");
  assert(!summary2.includes("<compacted-base"), "no base block (the first compaction has span details)");
  const s1 = spanBlock(summary2, 1);
  const s2 = spanBlock(summary2, 2);
  assert(s1 && s2, "spans n=1 and n=2 rendered");
  assert(summary2.indexOf('<compacted-span n="1"') < summary2.indexOf('<compacted-span n="2"'), "spans in chronological order");
  assert(s1.includes("Please fix the bug in foo.ts and make it robust."), "span 1 re-rendered from the first entry's details");
  assert(s1.includes("Now add unit tests for foo.ts covering the N=7 case."), "span 1 keeps its second user message");
  assert(s2.includes(`[Assistant tool calls] (outputs removed): bash(command="npm test -- --grep foo")`), "span 2 covers the previous retained tail");
  assert(result2.compaction.details.readFiles.includes("docs/guide.md"), "cumulative read list (new span)");
  assert.strictEqual(result2.compaction.details.span.reason, "threshold", "pi's raw reason passes through (threshold, not remapped to manual)");
  const span2TagT2 = summary2.match(/<compacted-span n="2"[^>]*>/)?.[0];
  assert(span2TagT2 && span2TagT2.includes('trigger="threshold"'), "span tag carries the raw reason");
  assert(summary2.includes('<read-files note="read before compaction; contents NOT in context">'), "read file list carries the content-free note");
  assert(!result2.compaction.details.readFiles.includes("src/foo.ts"), "edited file stays out of read list");
  assert(result2.compaction.details.modifiedFiles.includes("src/foo.ts") && result2.compaction.details.modifiedFiles.includes("src/foo.test.ts"), "cumulative modified list (carried + new)");
  console.log("  OK — previous summary embedded, file lists cumulative");

  // ---------------- Test 3: dump_context tool ----------------
  console.log("\n== Test 3: dump_context tool ==");
  const dumpRootDir = path.join(projectDir, ".pi", "context-dumps");
  const before = fs.existsSync(dumpRootDir) ? fs.readdirSync(dumpRootDir).length : 0;
  const r3 = await tools.dump_context.execute("tc1", { note: "test dump" }, new AbortController().signal, undefined, makeCtx());
  const dumpDirs = fs.readdirSync(dumpRootDir);
  assert.strictEqual(dumpDirs.length, before + 1, "new dump dir created");
  // locate this dump via the tool's returned path (dir names carry a random suffix, so "newest by name" is unreliable)
  const r3Md = r3.content[0].text.match(/dumped to (.+\.md)/)[1];
  const meta3 = JSON.parse(fs.readFileSync(path.join(path.dirname(r3Md), "meta.json"), "utf8"));
  assert.strictEqual(meta3.reason, "on-demand: test dump");
  assert(r3.content[0].text.includes("Context dumped to"), "tool returns dump path");
  console.log(`  OK -> ${path.basename(path.dirname(r3Md))}`);

  // ---------------- Test 4: context_lookup subagent loop ----------------
  console.log("\n== Test 4: context_lookup subagent loop (stub model) ==");
  let callCount = 0;
  const contexts = [];
  const stubRegistry = {
    complete: async (_model, context, _options) => {
      callCount++;
      contexts.push(context);
      const last = context.messages[context.messages.length - 1];
      if (last.role === "user") {
        return {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "toolCall", id: "call_grep1", name: "grep", arguments: { pattern: "MARKER_TEST_OUTPUT", after: 2 } },
          ],
          stopReason: "stop",
          usage: {},
        };
      }
      const toolResultText = context.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.content[0].text)
        .join("\n");
      assert(toolResultText.includes("MARKER_TEST_OUTPUT"), "grep found the marker in the dump");
      assert(toolResultText.includes("ENTRY"), "grep output attributes matches to entries");
      return {
        role: "assistant",
        content: [{ type: "text", text: "Finding: the bash test output confirmed '✓ handles N=7 (MARKER_TEST_OUTPUT)'. ENTRY e0009." }],
        stopReason: "stop",
        usage: {},
      };
    },
    find: () => undefined,
  };
  const ctx4 = makeCtx();
  ctx4.model = { id: "test-model", provider: "test" };
  ctx4.modelRegistry = stubRegistry;
  const r4 = await tools.context_lookup.execute("tc2", { question: "What did the test run output?" }, new AbortController().signal, undefined, ctx4);
  assert.strictEqual(callCount, 2, "subagent loop made exactly 2 model calls");
  assert(r4.content[0].text.includes("Finding:"), "final answer returned to main context");
  assert(!r4.content[0].text.includes(">> "), "main context gets findings, not raw grep output");
  const ctxJson = JSON.stringify(contexts[0].messages);
  assert(ctxJson.includes("list_entries") && ctxJson.includes("show_entry") && ctxJson.includes("grep"), "subagent tools declared to model");
  console.log(`  OK — answer: ${r4.content[0].text.slice(0, 60)}…`);

  // Exhaustion must get one extra tool-free call, with the last search results
  // available, rather than returning stale search narration as the answer.
  const searchTurns = Number.parseInt(process.env.MECH_COMPACT_LOOKUP_TURNS, 10) || 10;
  for (const outcome of ["success", "throw", "error", "aborted", "empty"]) {
    let calls = 0;
    let lookupSessionId;
    const signal = new AbortController().signal;
    const ctxLimit = makeCtx();
    ctxLimit.model = { id: "test-model", provider: "test" };
    ctxLimit.modelRegistry = {
      complete: async (_model, context, options) => {
        calls++;
        lookupSessionId ??= options.sessionId;
        assert.strictEqual(options.sessionId, lookupSessionId, "write-up uses the same lookup session");
        assert.strictEqual(options.signal, signal, "write-up forwards cancellation signal");
        assert.strictEqual(options.cacheRetention, "none");
        assert.strictEqual(options.maxTokens, 4096);
        const declaredTools = context.messages.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []);
        if (calls <= searchTurns) {
          assert.strictEqual(declaredTools.length, 3, "search calls expose lookup tools");
          return {
            role: "assistant",
            content: [
              { type: "text", text: `Search narration ${calls}` },
              { type: "toolCall", id: `limit_${calls}`, name: "grep", arguments: { pattern: "MARKER_TEST_OUTPUT" } },
            ],
            stopReason: "stop",
            usage: {},
          };
        }
        assert.strictEqual(calls, searchTurns + 1, "only one write-up call is allowed");
        assert.strictEqual(declaredTools.length, 0, "write-up exposes no tools");
        const last = context.messages[context.messages.length - 1];
        assert.strictEqual(last.role, "user");
        assert(last.content.includes("You are out of search turns."), "write-up asks for partial findings");
        const results = context.messages.filter((m) => m.role === "toolResult");
        assert.strictEqual(results.length, searchTurns, "write-up sees every search result, including the last");
        assert(results[results.length - 1].content[0].text.includes("MARKER_TEST_OUTPUT"), "last search evidence reaches write-up");
        if (outcome === "throw") throw new Error("write-up unavailable");
        return {
          role: "assistant",
          content: [{ type: "text", text: outcome === "empty" ? "" : "Confirmed partial finding with ENTRY e0009." }],
          stopReason: outcome === "error" || outcome === "aborted" ? outcome : "stop",
          errorMessage: outcome === "error" ? "write-up unavailable" : undefined,
          usage: {},
        };
      },
    };
    const partial = await tools.context_lookup.execute("tc_limit", { question: "What did the test run output?" }, signal, undefined, ctxLimit);
    assert.strictEqual(calls, searchTurns + 1, "exhaustion adds exactly one model call");
    const answer = partial.content[0].text;
    if (outcome === "success") {
      assert(answer.startsWith("Confirmed partial finding"), "write-up is returned instead of search narration");
      assert(answer.includes("write-up of partial findings"), "partial answer is labeled");
      assert(!answer.includes("Search narration"), "stale narration is not returned on success");
    } else {
      assert(answer.includes(`Search narration ${searchTurns}`), "failed write-up falls back to last text");
      assert(answer.includes("findings may be incomplete"), "fallback is labeled incomplete");
      if (outcome === "throw") assert(answer.includes("write-up failed: write-up unavailable"), "thrown failure is reported");
    }
  }
  console.log("  OK — exhausted lookup returns a tool-free write-up; failures retain the incomplete fallback");

  // show_entry resolves a real entry from the dump
  let turn = 0;
  const bigEntryId = entries.find((x) => x.type === "message" && x.message.role === "toolResult" && JSON.stringify(x.message.content).includes("MARKER_TOOL_OUTPUT_START")).id;
  const stub2 = {
    complete: async (_model, context) => {
      turn++;
      if (turn === 1)
        return { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "show_entry", arguments: { id: bigEntryId } }], stopReason: "stop", usage: {} };
      const tr = context.messages.filter((m) => m.role === "toolResult").map((m) => m.content[0].text).join("\n");
      assert(tr.includes(MARKER_OUTPUT), "show_entry returned full entry content");
      return { role: "assistant", content: [{ type: "text", text: "show_entry works" }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const ctx5 = makeCtx();
  ctx5.model = { id: "m", provider: "p" };
  ctx5.modelRegistry = stub2;
  const r5 = await tools.context_lookup.execute("tc3", { question: `show me entry ${bigEntryId}` }, new AbortController().signal, undefined, ctx5);
  assert(r5.content[0].text.includes("show_entry works"));
  console.log("  OK — show_entry resolves real dump entry content");

  // dumpDir: "all" searches every dump OF THIS SESSION (other sessions' dumps excluded)
  const foreignDir = path.join(projectDir, ".pi", "context-dumps", "1999-01-01T00-00-00_foreign");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "conversation.md"), "ENTRY fake0001  user  1999\nFOREIGN_SESSION_TEXT\n");
  fs.writeFileSync(path.join(foreignDir, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile: "/somewhere/other-session.jsonl", cwd: projectDir }));
  const allSeed = [];
  const stub3 = {
    complete: async (_m, context) => {
      allSeed.push(JSON.stringify(context.messages));
      return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const ctx6 = makeCtx();
  ctx6.model = { id: "m", provider: "p" };
  ctx6.modelRegistry = stub3;
  const r6 = await tools.context_lookup.execute("tc4", { question: "anything", dumpDir: "all" }, new AbortController().signal, undefined, ctx6);
  assert(r6.content[0].text.includes("done"));
  assert(!allSeed[0].includes("_foreign"), "foreign session's dump excluded from \"all\"");
  assert(!allSeed[0].includes("FOREIGN_SESSION_TEXT"), "foreign dump content not loaded");
  assert(allSeed[0].includes("context-dumps"), "this session's dumps included");
  console.log("  OK — dumpDir:\"all\" resolves every dump of this session (foreign excluded)");

  // ---------------- Test 5: /dump-context command ----------------
  console.log("\n== Test 5: /dump-context command ==");
  let notified = null;
  await commands["dump-context"].handler("via command", { ...makeCtx(), ui: { notify: (m) => (notified = m) } });
  assert(notified.includes("Context dumped to"), "command reports the dump path");
  const cmdMd = notified.match(/dumped to (.+\.md)/)[1];
  assert(fs.existsSync(cmdMd), "command created the dump");
  const t3DumpName = path.basename(path.dirname(r3Md));
  assert(!fs.existsSync(path.join(dumpRootDir, t3DumpName)), "Test 3's on-demand dump pruned (superseded by the command's dump)");
  console.log("  OK");

  // ---------------- Test 6: dump index, spoofing resistance, old-format fallback ----------------
  console.log("\n== Test 6: dump index + spoofing resistance + pre-index fallback ==");
  // 6a. index structure of the second dump (the Test 1 dump was pruned by the
  // second compaction — each new dump supersedes the earlier ones, see Test 14)
  const idxMeta = JSON.parse(fs.readFileSync(path.join(result2.compaction.details.dumpDir, "meta.json"), "utf8"));
  assert(Array.isArray(idxMeta.index) && idxMeta.index.length > 0, "meta.json has an entry index");
  const dumpLines = fs.readFileSync(path.join(result2.compaction.details.dumpDir, "conversation.md"), "utf8").split("\n");
  for (const e of [idxMeta.index[0], idxMeta.index[Math.floor(idxMeta.index.length / 2)], idxMeta.index[idxMeta.index.length - 1]]) {
    const headerLine = dumpLines[e.startLine - 1];
    assert(headerLine.startsWith("ENTRY "), "index startLine points at an ENTRY header");
    if (e.type !== "session") assert(headerLine.startsWith(`ENTRY ${e.id}`), `index startLine of ${e.type} entry points at its id`);
    assert(e.endLine > e.startLine && e.endLine <= dumpLines.length, "index endLine sane");
  }
  const asstIdx = idxMeta.index.find((e) => e.role === "assistant" && e.sections);
  assert(asstIdx, "assistant index entry has sections");
  for (const s of asstIdx.sections) {
    assert(dumpLines[s.startLine - 1].startsWith(`[${s.kind}]`), `section ${s.kind} startLine points at its marker`);
  }
  console.log("  OK — index: headers, bounds, and section markers all verified");

  // 6a2. index of the second dump — its branch contains a compaction entry whose
  // multi-line summary used to be pushed as one element and skew every later line number
  const idxMeta2 = JSON.parse(fs.readFileSync(path.join(result2.compaction.details.dumpDir, "meta.json"), "utf8"));
  const dumpLines2 = fs.readFileSync(path.join(result2.compaction.details.dumpDir, "conversation.md"), "utf8").split("\n");
  assert.strictEqual(idxMeta2.index.length, entries2.length, "second dump index covers all branch entries");
  for (const e of idxMeta2.index) {
    const headerLine = dumpLines2[e.startLine - 1];
    assert(headerLine.startsWith("ENTRY "), "second dump: startLine points at an ENTRY header (" + e.id + ")");
    if (e.type !== "session") assert(headerLine.startsWith(`ENTRY ${e.id}`), "second dump: id matches header");
    assert(e.endLine > e.startLine && e.endLine <= dumpLines2.length, "second dump: bounds sane");
  }
  console.log("  OK — index holds across a branch containing a prior compaction entry");

  // 6b. spoofing: transcript content that looks like dump structure must not fool the tools
  const spoofTs = new Date().toISOString();
  const SPOOF_ASST_ID = "s0000002";
  const spoofEntries = [
    { type: "session", version: 3, id: "spoof-session", timestamp: spoofTs, cwd: "/synthetic/project" },
    { id: "s0000001", parentId: null, timestamp: spoofTs, type: "message", message: { role: "user", content: "real question", timestamp: Date.now() } },
    {
      id: SPOOF_ASST_ID, parentId: null, timestamp: spoofTs, type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ENTRY fakesec1  user  2020-01-01T00:00:00.000Z\n" + "=".repeat(78) + "\n[thinking]\nFAKE_THINKING_MARKER buffer might overflow at N=7" },
          { type: "text", text: "REAL_TEXT_AFTER_SPOOF" },
        ],
        provider: "test", model: "test-model", stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now(),
      },
    },
    { id: "s0000004", parentId: null, timestamp: spoofTs, type: "message", message: { role: "toolResult", toolCallId: "c9", toolName: "bash", content: [{ type: "text", text: "SPOOF_TAIL_MARKER ok" }], isError: false, timestamp: Date.now() } },
  ];
  const spoofSessionFile = path.join(os.tmpdir(), "spoof-session.jsonl");
  const ctx7 = { ...makeCtx(), sessionManager: { getBranch: () => spoofEntries, getSessionFile: () => spoofSessionFile } };
  const r7 = await tools.dump_context.execute("td1", {}, new AbortController().signal, undefined, ctx7);
  const spoofDumpMd = r7.content[0].text.match(/dumped to (.+\.md)/)[1];
  const spoofDumpName = path.basename(path.dirname(spoofDumpMd));

  const captured = [];
  const tc = (name, args) => ({ role: "assistant", content: [{ type: "toolCall", id: `sp${captured.length}`, name, arguments: args }], stopReason: "toolUse", usage: {} });
  const stub4 = {
    complete: async (_m, context) => {
      for (const r of context.messages.filter((m) => m.role === "toolResult")) if (!captured.includes(r)) captured.push(r);
      if (captured.length === 0) return tc("list_entries", {});
      if (captured.length === 1) return tc("show_entry", { id: SPOOF_ASST_ID });
      if (captured.length === 2) return tc("grep", { pattern: "FAKE_THINKING_MARKER" });
      return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const ctx8 = { ...makeCtx(), sessionManager: ctx7.sessionManager, model: { id: "m", provider: "p" }, modelRegistry: stub4 };
  const r8 = await tools.context_lookup.execute("td2", { question: "anything", dumpDir: spoofDumpName }, new AbortController().signal, undefined, ctx8);
  assert(r8.content[0].text.includes("done"));
  const listRes = captured[0].content[0].text;
  const showRes = captured[1].content[0].text;
  const grepRes = captured[2].content[0].text;
  assert(!listRes.includes("fakesec1"), "list_entries: no phantom entry from spoofed thinking");
  assert(listRes.includes(SPOOF_ASST_ID), "list_entries: real assistant entry present");
  assert(showRes.includes("REAL_TEXT_AFTER_SPOOF"), "show_entry: block not cut short by spoofed ==== line");
  assert(grepRes.includes("FAKE_THINKING_MARKER"), "grep finds the marker");
  assert(grepRes.includes(`<< ENTRY ${SPOOF_ASST_ID}`), "grep hit attributed to the real entry");
  assert(grepRes.includes("[thinking]"), "grep hit attributed to the thinking section");
  console.log("  OK — spoofed ENTRY/====/[thinking] lines cannot fool list/show/grep; section provenance works");

  // 6c. pre-index dump (old format) still works via the scanning fallback
  const oldDirName = "1998-01-01T00-00-00_oldfmt";
  const oldDir = path.join(dumpRootDir, oldDirName);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(
    path.join(oldDir, "conversation.md"),
    ["# pi context dump", "", "=".repeat(78), "ENTRY old0001  user  1998-01-01T00:00:00.000Z", "OLD_FORMAT_USER_TEXT", "", "=".repeat(78), "ENTRY old0002  assistant (model=x/y, stop=stop)  1998-01-01T00:00:01.000Z", "[thinking]", "OLD_FORMAT_THINKING", ""].join("\n"),
  );
  fs.writeFileSync(path.join(oldDir, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile, cwd: projectDir }));
  const oldCaptured = [];
  const stub5 = {
    complete: async (_m, context) => {
      for (const r of context.messages.filter((m) => m.role === "toolResult")) if (!oldCaptured.includes(r)) oldCaptured.push(r);
      if (oldCaptured.length === 0) return { role: "assistant", content: [{ type: "toolCall", id: "o1", name: "show_entry", arguments: { id: "old0002" } }], stopReason: "toolUse", usage: {} };
      return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const ctx9 = makeCtx();
  ctx9.model = { id: "m", provider: "p" };
  ctx9.modelRegistry = stub5;
  const r9 = await tools.context_lookup.execute("td3", { question: "anything", dumpDir: oldDirName }, new AbortController().signal, undefined, ctx9);
  assert(r9.content[0].text.includes("done"));
  assert(oldCaptured[0].content[0].text.includes("OLD_FORMAT_THINKING"), "pre-index dump still searchable via scan fallback");
  console.log("  OK — pre-index dumps keep working (scan fallback)");

  // ---------------- helpers for the flat-span tests ----------------
  const tNow = Date.now();
  const mkMsg = (id, parent, role, text) => ({
    id,
    parentId: parent,
    timestamp: new Date(tNow).toISOString(),
    type: "message",
    message:
      role === "user"
        ? { role, content: text, timestamp: tNow }
        : {
            role,
            content: [{ type: "text", text }],
            provider: "test",
            model: "test-model",
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            timestamp: tNow,
          },
  });

  // ---------------- Test 7: three compactions -> flat spans + tiling ----------------
  console.log("\n== Test 7: three compactions -> flat spans n=1..3, tiling invariant ==");
  const u3 = mkMsg("u3", "cmp00001", "user", "Now document the fix in docs/guide.md.");
  const a3 = mkMsg("a3", "u3", "assistant", "Documenting the fix now.");
  const cmp2 = {
    type: "compaction",
    id: "cmp00002",
    parentId: "a3",
    timestamp: new Date().toISOString(),
    summary: result2.compaction.summary,
    firstKeptEntryId: keptEntries[2].id,
    tokensBefore: 200000,
    details: result2.compaction.details,
  };
  const a7 = mkMsg("a7", "cmp00002", "assistant", "Documentation complete.");
  const entries3 = [...entries2, u3, a3, cmp2, a7];
  const prep3 = {
    firstKeptEntryId: "a7",
    messagesToSummarize: [keptEntries[2].message, u3.message, a3.message],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 280000,
    previousSummary: result2.compaction.summary,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const ctxT7 = { ...makeCtx(), sessionManager: { getBranch: () => entries3, getSessionFile: () => sessionFile } };
  const result3 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prep3, branchEntries: entries3, reason: "threshold", willRetry: false, signal: new AbortController().signal },
    ctxT7,
  );
  const summary3 = result3.compaction.summary;
  assert.strictEqual(summary3.split("## Verbatim compaction checkpoint").length - 1, 1, "exactly one checkpoint header after 3 compactions");
  assert.strictEqual(summary3.split("Re-orient before continuing").length - 1, 1, "exactly one re-orientation block");
  assert(!summary3.includes("<compacted-base"), "no base block (all compactions have span details)");
  assert(summary3.includes("(compaction 3 on this branch)"), "header counts 3 compactions");
  const s1b = spanBlock(summary3, 1);
  const s2b = spanBlock(summary3, 2);
  const s3b = spanBlock(summary3, 3);
  assert(s1b && s2b && s3b, "spans n=1..3 all rendered");
  assert(
    summary3.indexOf('<compacted-span n="1"') < summary3.indexOf('<compacted-span n="2"') &&
      summary3.indexOf('<compacted-span n="2"') < summary3.indexOf('<compacted-span n="3"'),
    "spans in chronological order",
  );
  // Tiling invariant: every user message before the latest firstKept appears in exactly one span
  const userMsgs = [
    "Please fix the bug in foo.ts and make it robust.",
    "Now add unit tests for foo.ts covering the N=7 case.",
    "Now document the fix in docs/guide.md.",
  ];
  for (const um of userMsgs) {
    const count = [s1b, s2b, s3b].filter((s) => s && s.includes(um)).length;
    assert.strictEqual(count, 1, `user message in exactly one span: "${um}" (got ${count})`);
  }
  assert(s3b.includes("All tests pass. The fix handles the N=7 edge case."), "span 3 covers the previous retained tail");
  assert(!s3b.includes("Please fix the bug in foo.ts and make it robust."), "span 3 does not re-include span 1 content");
  console.log("  OK — flat spans n=1..3; user messages tile exactly once; retained tails covered");

  // ---------------- Test 8: legacy (pre-span) checkpoint -> base block ----------------
  console.log("\n== Test 8: legacy checkpoint rendered as <compacted-base> exactly once ==");
  const legacyTs = "2026-01-01T00:00:00.000Z";
  const legacySummary = [
    "## Mechanical compaction checkpoint",
    `- When: ${legacyTs} (trigger: manual, ~999 tokens before compaction)`,
    "- Removed from context: all assistant **thinking** and all **tool outputs**.",
    "- Full pre-compaction transcript: /tmp/legacy-dump/conversation.md",
    "",
    "**Re-orient before continuing.** (legacy checkpoint)",
    "",
    "### Previous checkpoint (verbatim)",
    "(none — first mechanical compaction)",
    "",
    "### Conversation (span replaced by this checkpoint)",
    "[User]: LEGACY_USER_MSG from before the span format",
  ].join("\n");
  const legacyBranch = [
    { type: "session", version: 3, id: "legacy-session", timestamp: legacyTs, cwd: "/synthetic/project" },
    mkMsg("l0001", null, "user", "LEGACY_USER_MSG from before the span format"),
    mkMsg("l0002", "l0001", "assistant", "LEGACY_ASSISTANT_PROSE done"),
    {
      type: "compaction",
      id: "lc0001",
      parentId: "l0002",
      timestamp: legacyTs,
      summary: legacySummary,
      firstKeptEntryId: "l0002",
      tokensBefore: 999,
      details: { kind: "mech-compact", dumpDir: "/tmp/legacy-dump", readFiles: ["src/legacy.ts"], modifiedFiles: [] },
    },
    mkMsg("l0003", "lc0001", "user", "LEGACY_TAIL_USER_MSG retained after the legacy checkpoint"),
    mkMsg("l0004", "l0003", "assistant", "NEW_AFTER_LEGACY_PROSE"),
  ];
  const legacySessionFile = path.join(os.tmpdir(), "legacy-base-session.jsonl");
  const ctxT8 = { ...makeCtx(), sessionManager: { getBranch: () => legacyBranch, getSessionFile: () => legacySessionFile } };
  const prepT8 = {
    firstKeptEntryId: "l0004",
    messagesToSummarize: [legacyBranch[2].message, legacyBranch[4].message], // retained tail l0002 + l0003
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1500,
    previousSummary: legacySummary,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const result4 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prepT8, branchEntries: legacyBranch, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctxT8,
  );
  const summary4 = result4.compaction.summary;
  assert(summary4.includes(`<compacted-base kind="legacy-checkpoint" compacted-at="${legacyTs}">`), "legacy checkpoint rendered as base with its timestamp (compacted-at)");
  assert.strictEqual(summary4.split("LEGACY_USER_MSG").length - 1, 1, "base summary text appears exactly once");
  assert.strictEqual(summary4.split("### Previous checkpoint").length - 1, 1, "the old-format string appears only inside the base block");
  assert(summary4.includes("LEGACY_TAIL_USER_MSG"), "new span covers the retained tail after the base");
  assert(!summary4.includes("NEW_AFTER_LEGACY_PROSE"), "retained entry l0004 is not in the span");
  assert(result4.compaction.details.readFiles.includes("src/legacy.ts"), "file lists carried from the legacy entry");
  assert(!result4.compaction.details.modifiedFiles.includes("src/legacy.ts"), "legacy read list does not pollute modified");
  console.log("  OK — legacy checkpoint is the base (exactly once); file lists carried over");

  // ---------------- Test 9: model-summary base; pre-base span not re-rendered ----------------
  console.log("\n== Test 9: model-summary base; pre-base mech span not re-rendered ==");
  const cmpModel = {
    type: "compaction",
    id: "cmpmodel1",
    parentId: "cmp00001",
    timestamp: new Date().toISOString(),
    summary: "MODEL_SUMMARY_OPAQUE covers the middle of the conversation.",
    firstKeptEntryId: keptEntries[2].id,
    tokensBefore: 250000,
    details: {},
  };
  const u4 = mkMsg("u4", "cmpmodel1", "user", "AFTER_MODEL_SUMMARY ask for a benchmark.");
  const a4 = mkMsg("a4", "u4", "assistant", "Benchmarking now.");
  const a8 = mkMsg("a8", "a4", "assistant", "Benchmark done.");
  const entries4 = [...entries2, cmpModel, u4, a4, a8];
  const prepT9 = {
    firstKeptEntryId: "a8",
    messagesToSummarize: [keptEntries[2].message, u4.message, a4.message],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 300000,
    previousSummary: cmpModel.summary,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const ctxT9 = { ...makeCtx(), sessionManager: { getBranch: () => entries4, getSessionFile: () => sessionFile } };
  const result5 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prepT9, branchEntries: entries4, reason: "threshold", willRetry: false, signal: new AbortController().signal },
    ctxT9,
  );
  const summary5 = result5.compaction.summary;
  assert(summary5.includes('<compacted-base kind="model-summary"'), "model summary rendered as base");
  assert.strictEqual(summary5.split("MODEL_SUMMARY_OPAQUE").length - 1, 1, "base text exactly once");
  assert(summary5.includes("AFTER_MODEL_SUMMARY"), "new span rendered");
  assert(!summary5.includes("Please fix the bug in foo.ts and make it robust."), "pre-base mech span (cmp00001) not re-rendered");
  assert.strictEqual((summary5.match(/<compacted-span /g) ?? []).length, 1, "exactly one span (the new one)");
  console.log("  OK — model summary is the base; older mech span is not re-rendered");

  // ---------------- Test 10: /tree navigation — abandoned-branch spans not rendered ----------------
  console.log("\n== Test 10: spans on abandoned branches are not rendered ==");
  const treeNow = new Date().toISOString();
  // Branch A (abandoned) has its own mech span entry — present in the session
  // file, but NOT on the current path (getBranch returns only the current path).
  const treeACmp = {
    type: "compaction",
    id: "tc0001",
    parentId: "t0002",
    timestamp: treeNow,
    summary: "## Mechanical compaction checkpoint (abandoned branch)\n[User]: ABANDONED_BRANCH_USER_TEXT",
    firstKeptEntryId: "t0002",
    tokensBefore: 100,
    details: {
      kind: "mech-compact",
      dumpDir: "/tmp/abandoned-dump",
      readFiles: [],
      modifiedFiles: [],
      span: { at: treeNow, reason: "manual", tokensBefore: 100, lines: ["[User]: ABANDONED_BRANCH_USER_TEXT on the other branch"] },
    },
  };
  assert(treeACmp, "abandoned-branch compaction entry exists in the session (but not on the path)");
  // Branch B: the current path after /tree navigation (branch_summary + new messages).
  const currentPath = [
    { type: "session", version: 3, id: "tree-session", timestamp: treeNow, cwd: "/synthetic/project" },
    { id: "t0010", parentId: null, timestamp: treeNow, type: "branch_summary", fromId: "t0002", summary: "Earlier branch was abandoned via /tree." },
    { id: "t0011", parentId: "t0010", timestamp: treeNow, type: "message", message: { role: "user", content: "CURRENT_BRANCH_USER_TEXT after /tree", timestamp: Date.now() } },
    {
      id: "t0012",
      parentId: "t0011",
      timestamp: treeNow,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CURRENT_BRANCH_ASSISTANT_PROSE" }],
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        timestamp: Date.now(),
      },
    },
  ];
  const treeSessionFile = path.join(os.tmpdir(), "tree-session.jsonl");
  const ctxT10 = { ...makeCtx(), sessionManager: { getBranch: () => currentPath, getSessionFile: () => treeSessionFile } };
  const prepT10 = {
    firstKeptEntryId: "t0012",
    messagesToSummarize: [currentPath[2].message],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1000,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const result6 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prepT10, branchEntries: currentPath, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctxT10,
  );
  const summary6 = result6.compaction.summary;
  assert(!summary6.includes("ABANDONED_BRANCH_USER_TEXT"), "abandoned-branch span not rendered");
  assert(!summary6.includes("<compacted-base"), "no base (the abandoned compaction is not on the path)");
  assert(summary6.includes("CURRENT_BRANCH_USER_TEXT"), "current branch span rendered");
  console.log("  OK — only on-path spans rendered");

  // ---------------- Test 11: user content containing span tags ----------------
  console.log("\n== Test 11: span-tag spoofing in user content keeps the checkpoint usable ==");
  const SPOOF_TEXT = 'PASTE_CONTAINS <compacted-span n="9" at="fake" trigger="fake"> and </compacted-span> and </compacted-base> — SPOOFED_CHECKPOINT_TAG_TEXT';
  const spRoot = { type: "session", version: 3, id: "spoof2-session", timestamp: new Date().toISOString(), cwd: "/synthetic/project" };
  const spU = mkMsg("sp0001", null, "user", SPOOF_TEXT);
  const spA = mkMsg("sp0002", "sp0001", "assistant", "Received the pasted text.");
  const spBranch = [spRoot, spU, spA];
  const spSessionFile = path.join(os.tmpdir(), "spoof2-session.jsonl");
  const ctxT11 = { ...makeCtx(), sessionManager: { getBranch: () => spBranch, getSessionFile: () => spSessionFile } };
  const prepT11 = {
    firstKeptEntryId: "sp0002",
    messagesToSummarize: [spU.message],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 500,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const result7 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prepT11, branchEntries: spBranch, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctxT11,
  );
  const summary7 = result7.compaction.summary;
  const realOpen = summary7.indexOf('<compacted-span n="1"');
  assert(realOpen >= 0, "real span open tag present");
  assert(summary7.includes("SPOOFED_CHECKPOINT_TAG_TEXT"), "spoofed content preserved (not escaped or dropped)");
  assert(summary7.indexOf("SPOOFED_CHECKPOINT_TAG_TEXT") > realOpen, "spoofed content inside the real span block");
  assert.strictEqual((summary7.match(/<compacted-span n="/g) ?? []).length, 2, "one real + one spoofed opener — nothing lost");
  assert.strictEqual((summary7.match(/<\/compacted-span>/g) ?? []).length, 2, "one real + one spoofed closer — nothing lost");
  const keptEntryT11 = spBranch.find((e) => e.id === prepT11.firstKeptEntryId);
  assert(
    summary7.endsWith(`Conversation from ${keptEntryT11.timestamp} onward continues verbatim below — it was not compacted.`),
    "checkpoint ends with the closing line after the last span (structure intact)",
  );
  console.log("  OK — spoofed tags kept verbatim; real tags findable; structure intact");

  // ---------------- Test 12: legacy span (no from/to) renders without covers ----------------
  console.log("\n== Test 12: legacy span without from/to renders without covers ==");
  const lsTs = "2026-02-01T00:00:00.000Z";
  const lsBranch = [
    { type: "session", version: 3, id: "legacyspan-session", timestamp: lsTs, cwd: "/synthetic/project" },
    mkMsg("ls0001", null, "user", "LEGACYSPAN_USER_MSG before the covers era"),
    mkMsg("ls0002", "ls0001", "assistant", "LEGACYSPAN_ASSISTANT_PROSE"),
    {
      type: "compaction",
      id: "lsc0001",
      parentId: "ls0002",
      timestamp: lsTs,
      summary: "## Mechanical compaction checkpoint (legacy span era)",
      firstKeptEntryId: "ls0002",
      tokensBefore: 123,
      details: {
        kind: "mech-compact",
        dumpDir: "/tmp/legacyspan-dump",
        readFiles: [],
        modifiedFiles: [],
        // pre-covers span details: has lines, no from/to
        span: { at: lsTs, reason: "manual", tokensBefore: 123, lines: ["[User]: LEGACYSPAN_USER_MSG before the covers era"] },
      },
    },
    mkMsg("ls0003", "lsc0001", "user", "NEW_MSG after the legacy span"),
  ];
  const lsSessionFile = path.join(os.tmpdir(), "legacyspan-session.jsonl");
  const ctxT12 = { ...makeCtx(), sessionManager: { getBranch: () => lsBranch, getSessionFile: () => lsSessionFile } };
  const prepT12 = {
    firstKeptEntryId: "ls0003",
    messagesToSummarize: [lsBranch[2].message, lsBranch[4].message], // retained tail (assistant) + new user msg
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 234,
    previousSummary: "## Mechanical compaction checkpoint (legacy span era)",
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: preparation.settings,
  };
  const result8 = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prepT12, branchEntries: lsBranch, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctxT12,
  );
  const summary8 = result8.compaction.summary;
  const lsTag1 = summary8.match(/<compacted-span n="1"[^>]*>/)?.[0];
  assert(lsTag1, "legacy span open tag found");
  assert(!lsTag1.includes("covers="), "legacy span (no from/to) renders without covers");
  assert(lsTag1.includes(`compacted-at="${lsTs}"`), "legacy span's at is rendered as compacted-at");
  const lsTag2 = summary8.match(/<compacted-span n="2"[^>]*>/)?.[0];
  assert(lsTag2 && lsTag2.includes("covers="), "the new span renders its covers range");
  assert(summary8.includes("LEGACYSPAN_USER_MSG"), "legacy span content re-rendered");
  assert(!summary8.includes("<compacted-base"), "legacy span with details.span is not treated as base");
  console.log("  OK — legacy spans render without covers; new spans carry covers");

  // ---------------- Test 13: scoping by entry-id overlap ----------------
  console.log("\n== Test 13: scoping by entry-id overlap (incl. ephemeral sessions) ==");
  const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-scope-"));
  const scopeRoot = path.join(scopeDir, ".pi", "context-dumps");
  fs.mkdirSync(scopeRoot, { recursive: true });
  const mkScopeCtx = (getFile) => ({
    cwd: scopeDir,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => entries, getSessionFile: getFile },
  });
  // own dump (indexed; contains e0000 = the branch's first entry id)
  const rOwn = await tools.dump_context.execute("ts1", {}, new AbortController().signal, undefined, mkScopeCtx(() => sessionFile));
  const ownDumpName = path.basename(path.dirname(rOwn.content[0].text.match(/dumped to (.+\.md)/)[1]));
  // a foreign session's INDEXED dump (its ids can never match this branch)
  const foreignIdx = "2000-01-01T00-00-00_foreignidx";
  fs.mkdirSync(path.join(scopeRoot, foreignIdx), { recursive: true });
  fs.writeFileSync(path.join(scopeRoot, foreignIdx, "conversation.md"), "ENTRY x00001  user  2000-01-01T00:00:00.000Z\nFOREIGN_IDX_TEXT\n");
  fs.writeFileSync(path.join(scopeRoot, foreignIdx, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile: "/somewhere/other.jsonl", cwd: scopeDir, index: [{ id: "x00001", type: "message", startLine: 4, endLine: 5 }] }));
  // a pre-index dump whose meta.json sessionFile matches this session
  const preIdx = "2000-02-02T00-00-00_preidx";
  fs.mkdirSync(path.join(scopeRoot, preIdx), { recursive: true });
  fs.writeFileSync(path.join(scopeRoot, preIdx, "conversation.md"), "ENTRY p00001  user  2000-02-02T00:00:00.000Z\nPREIDX_SESSION_TEXT\n");
  fs.writeFileSync(path.join(scopeRoot, preIdx, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile, cwd: scopeDir }));
  const seeds = [];
  const stubSeeds = {
    complete: async (_m, context) => {
      seeds.push(JSON.stringify(context.messages));
      return { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const lookupAll = (ctx) => {
    const c = { ...ctx, model: { id: "m", provider: "p" }, modelRegistry: stubSeeds };
    seeds.length = 0;
    return tools.context_lookup.execute("ts2", { question: "x", dumpDir: "all" }, new AbortController().signal, undefined, c);
  };
  // 13a. ephemeral session (no session file): scoped by entry ids alone
  await lookupAll(mkScopeCtx(() => null));
  assert(seeds[0].includes(ownDumpName), "ephemeral: own indexed dump found");
  assert(!seeds[0].includes(foreignIdx), "ephemeral: foreign indexed dump excluded");
  assert(!seeds[0].includes(preIdx), "ephemeral: pre-index dump excluded (no sessionFile to match)");
  // 13b. file-backed session: pre-index dump included via the sessionFile fallback
  await lookupAll(mkScopeCtx(() => sessionFile));
  assert(seeds[0].includes(ownDumpName) && seeds[0].includes(preIdx), "file-backed: own + pre-index (sessionFile) dumps found");
  assert(!seeds[0].includes(foreignIdx), "file-backed: foreign indexed dump still excluded");
  // 13c. explicit dir name / absolute path bypass scoping
  {
    const c = { ...mkScopeCtx(() => null), model: { id: "m", provider: "p" }, modelRegistry: stubSeeds };
    seeds.length = 0;
    await tools.context_lookup.execute("ts3", { question: "x", dumpDir: foreignIdx }, new AbortController().signal, undefined, c);
    assert(seeds[0].includes(foreignIdx), "explicit dir name bypasses scoping");
    seeds.length = 0;
    await tools.context_lookup.execute("ts4", { question: "x", dumpDir: path.join(scopeRoot, preIdx) }, new AbortController().signal, undefined, c);
    assert(seeds[0].includes(preIdx), "absolute path bypasses scoping");
  }
  console.log("  OK — ephemeral sessions scoped by entry ids; pre-index fallback; explicit bypass");

  // ---------------- Test 14: pruning of redundant dumps ----------------
  console.log("\n== Test 14: pruning of redundant dumps ==");
  const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-prune-"));
  const pruneRoot = path.join(pruneDir, ".pi", "context-dumps");
  const prNotifies = [];
  const prCtx = (branch) => ({
    cwd: pruneDir,
    ui: { notify: (m, k) => prNotifies.push(`${k || "info"}: ${m}`) },
    sessionManager: { getBranch: () => branch, getSessionFile: () => sessionFile },
  });
  const pDirs = () => (fs.existsSync(pruneRoot) ? fs.readdirSync(pruneRoot).sort() : []);
  const compactAt = (branch, firstKeptId, msgs, n) =>
    handlers.session_before_compact(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: firstKeptId,
          messagesToSummarize: msgs.map((m) => m.message),
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100000 + n,
          previousSummary: undefined,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: preparation.settings,
        },
        branchEntries: branch,
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      prCtx(branch),
    );
  // 14a. on-demand dump, then two sequential compactions -> exactly one dump remains
  await tools.dump_context.execute("tp1", {}, new AbortController().signal, undefined, prCtx(entries));
  assert.strictEqual(pDirs().length, 1, "on-demand dump created");
  let rr = await compactAt(entries, entries[2].id, [entries[1]], 1);
  assert(rr.compaction, "compaction 1 returned");
  assert.strictEqual(pDirs().length, 1, "on-demand dump pruned by the first compaction");
  const branch2 = [
    ...entries,
    { type: "compaction", id: "pc0001", parentId: entries[entries.length - 1].id, timestamp: new Date().toISOString(), summary: rr.compaction.summary, firstKeptEntryId: entries[2].id, tokensBefore: 100001, details: rr.compaction.details },
  ];
  rr = await compactAt(branch2, entries[4].id, [entries[3]], 2);
  assert(rr.compaction, "compaction 2 returned");
  assert.strictEqual(pDirs().length, 1, "two sequential compactions leave exactly one dump for the session");
  assert.strictEqual(pDirs()[0], path.basename(rr.compaction.details.dumpDir), "the remaining dump is the latest one");
  const supersededName = pDirs()[0];
  // 14b. a dump holding an entry off the current branch survives pruning
  const divA = mkMsg("divA", "pc0001", "assistant", "ABANDONED_BRANCH_ONLY_TEXT on the old continuation");
  const branchAb = [...branch2, divA];
  const rrAb = await compactAt(branchAb, divA.id, [divA], 3);
  assert(rrAb.compaction, "compaction on the old continuation returned");
  const divB = mkMsg("divB", "pc0001", "assistant", "CURRENT_BRANCH_TEXT the new continuation");
  const branchCur = [...branch2, divB];
  const rrCur = await compactAt(branchCur, divB.id, [divB], 4);
  assert(rrCur.compaction, "compaction on the current branch returned");
  assert.strictEqual(pDirs().length, 2, "abandoned-branch dump survives (its entry is not in the new dump)");
  const abName = pDirs().find((d) => d !== path.basename(rrCur.compaction.details.dumpDir));
  assert(fs.readFileSync(path.join(pruneRoot, abName, "conversation.md"), "utf8").includes("ABANDONED_BRANCH_ONLY_TEXT"), "the surviving dump is the abandoned-branch one");
  // 14c. after pruning, "all" returns only the non-redundant dumps
  {
    const c = { ...prCtx(branchCur), model: { id: "m", provider: "p" }, modelRegistry: stubSeeds };
    seeds.length = 0;
    await tools.context_lookup.execute("tp2", { question: "x", dumpDir: "all" }, new AbortController().signal, undefined, c);
    assert(seeds[0].includes(abName) && seeds[0].includes(path.basename(rrCur.compaction.details.dumpDir)), "\"all\" returns the non-redundant dumps");
    assert(!seeds[0].includes(supersededName), "superseded (redundant) dump is not in \"all\"");
  }
  // 14d. pre-index and foreign dumps survive pruning
  const preP = "2001-01-01T00-00-00_pre";
  fs.mkdirSync(path.join(pruneRoot, preP), { recursive: true });
  fs.writeFileSync(path.join(pruneRoot, preP, "conversation.md"), "ENTRY q00001  user  2001-01-01T00:00:00.000Z\nPRE_PRUNE_TEXT\n");
  fs.writeFileSync(path.join(pruneRoot, preP, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile, cwd: pruneDir }));
  const fP = "2001-02-02T00-00-00_foreign";
  fs.mkdirSync(path.join(pruneRoot, fP), { recursive: true });
  fs.writeFileSync(path.join(pruneRoot, fP, "conversation.md"), "ENTRY z00001  user  2001-02-02T00:00:00.000Z\nFOREIGN_PRUNE_TEXT\n");
  fs.writeFileSync(path.join(pruneRoot, fP, "meta.json"), JSON.stringify({ kind: "pi-context-dump", sessionFile: "/other/s.jsonl", cwd: pruneDir, index: [{ id: "z00001", type: "message", startLine: 4, endLine: 5 }] }));
  const divC = mkMsg("divC", divB.id, "assistant", "one more message");
  const branchCur2 = [...branchCur, divC];
  const rr5 = await compactAt(branchCur2, divC.id, [divC], 5);
  assert(rr5.compaction, "compaction with pre-index + foreign dumps present returned");
  const after = pDirs();
  assert(after.includes(preP), "pre-index dump survives pruning");
  assert(after.includes(fP), "foreign session's indexed dump survives pruning");
  assert(after.includes(abName), "abandoned-branch dump still there");
  assert(after.includes(path.basename(rr5.compaction.details.dumpDir)), "new dump present");
  // 14e. unreadable meta.json elsewhere: compaction succeeds, dir kept, reported
  const badP = "2001-03-03T00-00-00_badmeta";
  fs.mkdirSync(path.join(pruneRoot, badP), { recursive: true });
  fs.writeFileSync(path.join(pruneRoot, badP, "conversation.md"), "ENTRY b00001  user  2001-03-03T00:00:00.000Z\nBAD_META_TEXT\n");
  fs.writeFileSync(path.join(pruneRoot, badP, "meta.json"), "{ not valid json");
  prNotifies.length = 0;
  const divD = mkMsg("divD", divC.id, "assistant", "and another");
  const branchCur3 = [...branchCur2, divD];
  const rr6 = await compactAt(branchCur3, divD.id, [divD], 6);
  assert(rr6.compaction, "compaction succeeds despite an unreadable meta.json in another dump");
  assert(fs.existsSync(path.join(pruneRoot, badP)), "unreadable-meta dir left untouched");
  assert(prNotifies.some((n) => n.includes("unreadable meta.json") && n.includes(badP)), "the unreadable meta.json is reported");
  console.log("  OK — superseded dumps pruned; abandoned-branch, pre-index, foreign and unreadable dumps kept");

  // ---------------- Test 15: git ignore warning for un-ignored dumps ----------------
  console.log("\n== Test 15: git ignore warning ==");
  let gitAvailable = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    console.log("  SKIP — git not available");
  } else {
    const prepFor = (ent) => {
      const msg = ent.filter((x) => x.type === "message");
      return {
        firstKeptEntryId: msg.slice(-3)[0].id,
        messagesToSummarize: msg.slice(0, -3).map((x) => x.message),
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 1000,
        previousSummary: undefined,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      };
    };
    const gitCtx = (cwd, notifs, ent) => ({
      cwd,
      mode: "tui",
      hasUI: true,
      ui: { notify: (m, k) => notifs.push(`${k || "info"}: ${m}`) },
      sessionManager: { getBranch: () => ent, getSessionFile: () => null },
      modelRegistry: {},
      model: undefined,
    });
    const runCompaction = (ctx) =>
      handlers.session_before_compact(
        {
          type: "session_before_compact",
          preparation: prepFor(ctx.sessionManager.getBranch()),
          branchEntries: ctx.sessionManager.getBranch(),
          reason: "manual",
          willRetry: false,
          signal: new AbortController().signal,
        },
        ctx,
      );
    // Un-ignored repo: warn once, then memoize per dump root.
    const gitA = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-gita-"));
    execFileSync("git", ["init", "-q"], { cwd: gitA });
    const { entries: entA } = makeSessionFile();
    const notifsA = [];
    const ctxA = gitCtx(gitA, notifsA, entA);
    const resA = await runCompaction(ctxA);
    assert(resA && resA.compaction, "compaction in un-ignored repo succeeded");
    let warnsA = notifsA.filter((n) => n.includes("not git-ignored"));
    assert.strictEqual(warnsA.length, 1, "un-ignored dump root warns once");
    assert(warnsA[0].startsWith("warning:"), "warning is at warning level");
    assert(warnsA[0].includes("MECH_COMPACT_DUMP_DIR"), "warning offers the override as an escape hatch");
    await runCompaction(ctxA);
    assert.strictEqual(notifsA.filter((n) => n.includes("not git-ignored")).length, 1, "warning memoized per dump root");
    // Ignored repo: no warning.
    const gitB = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-gitb-"));
    execFileSync("git", ["init", "-q"], { cwd: gitB });
    fs.writeFileSync(path.join(gitB, ".gitignore"), ".pi/context-dumps/\n", "utf8");
    const { entries: entB } = makeSessionFile();
    const notifsB = [];
    const ctxB = gitCtx(gitB, notifsB, entB);
    await runCompaction(ctxB);
    assert.strictEqual(notifsB.filter((n) => n.includes("not git-ignored")).length, 0, "ignored dump root does not warn");
    console.log("  OK — warns once for un-ignored repo (memoized); silent when ignored or outside git");
  }

  console.log("\nALL TESTS PASSED");
  console.log(`test project dir: ${projectDir}`);
}

async function capTest() {
  const mod = await jiti.import(EXT_PATH);
  const { handlers, pi } = loadExt();
  mod.default(pi);
  const { file: sessionFile, entries } = makeSessionFile();
  const msgEntries = entries.filter((x) => x.type === "message");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-cap-"));
  const ctx = {
    cwd: projectDir,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
  };
  const prep = {
    firstKeptEntryId: msgEntries[msgEntries.length - 1].id,
    messagesToSummarize: msgEntries.slice(0, -1).map((x) => x.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 999999,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const result = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prep, branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctx,
  );
  const summary = result.compaction.summary;
  const budget = Number(process.env.MECH_COMPACT_MAX_SUMMARY_CHARS || 80000);
  const convSection = summary.split("### Compacted conversation (oldest first)")[1];
  assert(convSection.length <= budget + 2000, `conversation section ${convSection.length} chars exceeds budget ${budget}+2000`);
  assert(summary.includes("[User]:"), "user lines survive the cap");
  assert(!summary.includes("MARKER_TOOL_OUTPUT_START"), "no tool output regardless of cap");
  console.log(`CAP TEST OK — budget ${budget}, conversation section ${convSection.length} chars, total summary ${summary.length} chars`);
}

async function capHangTest() {
  // Regression: capConversation used to re-stub the same oversized user line
  // forever (the stub length has a fixed point of ~151 chars, still > 120),
  // hanging pi mid-compaction whenever user messages alone exceeded the budget.
  const mod = await jiti.import(EXT_PATH);
  const { handlers, pi } = loadExt();
  mod.default(pi);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  // Two large pasted logs (the real-world trigger): the old step 2 re-stubbed the
  // FIRST user line over and over until it hit the stub fixed point (~151 chars,
  // where the size delta goes to zero) while the second line kept over() true.
  const hugeA = "PASTED LOG LINE A ".repeat(2000); // 30k chars
  const hugeB = "PASTED LOG LINE B ".repeat(2000); // 30k chars
  const entries = [
    { type: "session", version: 3, id: "cap-hang-session", timestamp: ts, cwd: "/synthetic/project" },
    { id: "e0001", parentId: null, timestamp: ts, type: "message", message: { role: "user", content: hugeA, timestamp: now } },
    { id: "e0002", parentId: null, timestamp: ts, type: "message", message: { role: "user", content: hugeB, timestamp: now } },
    {
      id: "e0003", parentId: null, timestamp: ts, type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "test", model: "test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: now },
    },
  ];
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-caphang-"));
  const sessionFile = path.join(os.tmpdir(), "cap-hang-session.jsonl");
  const ctx = {
    cwd: projectDir,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
  };
  const prep = {
    firstKeptEntryId: "e0003",
    messagesToSummarize: [entries[1].message, entries[2].message],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 500000,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const start = Date.now();
  const result = await handlers.session_before_compact(
    { type: "session_before_compact", preparation: prep, branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctx,
  );
  const ms = Date.now() - start;
  assert(result && result.compaction, "hook returned a compaction (no hang)");
  const budget = Number(process.env.MECH_COMPACT_MAX_SUMMARY_CHARS || 80000);
  if (!process.env.MECH_COMPACT_MAX_SUMMARY_CHARS) {
    assert(result.compaction.summary.includes(hugeA) && result.compaction.summary.includes(hugeB), "default 80k budget retains content beyond the old 40k cap");
  }
  const convSection = result.compaction.summary.split("### Compacted conversation (oldest first)")[1] ?? "";
  assert(convSection.length <= budget + 200, `conversation section ${convSection.length} chars exceeds budget ${budget}+200`);
  console.log(`CAP-HANG TEST OK — terminated in ${ms}ms, conversation section ${convSection.length} chars (budget ${budget}, user lines ${hugeA.length}+${hugeB.length} chars)`);
}

async function capSpansTest() {
  // Cross-span size guard: two compactions, each with two huge user messages,
  // tiny budget. The oldest span's lines must be dropped first, and the cap
  // must terminate (no re-stub loops across spans).
  process.env.MECH_COMPACT_MAX_SUMMARY_CHARS = "800";
  const jiti2 = createJiti(__filename, { alias: jitiAliases }); // fresh instance: cfg reads env at load
  const mod = await jiti2.import(EXT_PATH);
  const { handlers, pi } = loadExt();
  mod.default(pi);
  const now = Date.now();
  const ts = new Date(now).toISOString();
  const mkU = (id, parent, text) => ({ id, parentId: parent, timestamp: ts, type: "message", message: { role: "user", content: text, timestamp: now } });
  const mkA = (id, parent, text) => ({
    id,
    parentId: parent,
    timestamp: ts,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }], provider: "test", model: "test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: now },
  });
  const hugeA = "PASTED LOG LINE A ".repeat(2000); // 30k chars
  const hugeB = "PASTED LOG LINE B ".repeat(2000);
  const hugeC = "PASTED LOG LINE C ".repeat(2000);
  const hugeD = "PASTED LOG LINE D ".repeat(2000);
  const session = { type: "session", version: 3, id: "cap-spans-session", timestamp: ts, cwd: "/synthetic/project" };
  const eA = mkU("cs0001", null, hugeA);
  const eB = mkU("cs0002", "cs0001", hugeB);
  const eA1 = mkA("cs0003", "cs0002", "done one");
  const entries1 = [session, eA, eB, eA1];
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-capspans-"));
  const sessionFile = path.join(os.tmpdir(), "cap-spans-session.jsonl");
  const baseCtx = { cwd: projectDir, ui: { notify: () => {} }, sessionManager: { getBranch: () => entries1, getSessionFile: () => sessionFile } };
  const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
  const start = Date.now();
  const result1 = await handlers.session_before_compact(
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "cs0003", messagesToSummarize: [eA.message, eB.message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 500000, previousSummary: undefined, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings },
      branchEntries: entries1,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    baseCtx,
  );
  assert(result1.compaction, "first compaction returned (no hang)");
  const cmp1 = { type: "compaction", id: "cc0001", parentId: "cs0003", timestamp: ts, summary: result1.compaction.summary, firstKeptEntryId: "cs0003", tokensBefore: 500000, details: result1.compaction.details };
  const eC = mkU("cs0004", "cc0001", hugeC);
  const eD = mkU("cs0005", "cs0004", hugeD);
  const eA2 = mkA("cs0006", "cs0005", "done two");
  const entries2 = [...entries1, cmp1, eC, eD, eA2];
  const ctx2 = { ...baseCtx, sessionManager: { getBranch: () => entries2, getSessionFile: () => sessionFile } };
  const result2 = await handlers.session_before_compact(
    {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "cs0006", messagesToSummarize: [eA1.message, eC.message, eD.message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 600000, previousSummary: result1.compaction.summary, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings },
      branchEntries: entries2,
      reason: "auto",
      willRetry: false,
      signal: new AbortController().signal,
    },
    ctx2,
  );
  const ms = Date.now() - start;
  assert(result2.compaction, "second compaction returned (no hang)");
  const summary = result2.compaction.summary;
  const budget = 800;
  const convSection = summary.split("### Compacted conversation (oldest first)")[1] ?? "";
  assert(convSection.length <= budget + 200, `conversation section ${convSection.length} chars exceeds budget ${budget}+200`);
  assert(summary.includes("PASTED LOG LINE D"), "newest user line survives as a stub");
  assert(summary.includes("PASTED LOG LINE B"), "span 1's second user line survives as a stub");
  assert(!summary.includes("PASTED LOG LINE A "), "oldest span's first user line dropped first");
  assert.strictEqual((summary.match(/<compacted-span /g) ?? []).length, 2, "both spans rendered (possibly trimmed)");
  console.log(`CAP-SPANS TEST OK — terminated in ${ms}ms, section ${convSection.length} chars (budget ${budget}), oldest span trimmed first`);
}

// ---------------------------------------------------------------------------
// Mode: nowarn — MECH_COMPACT_WARN_GITIGNORE=0 silences the git-ignore warning.
// Runs as its own process because the flag is read at module load. Test 15
// proves the warning fires under identical conditions without the flag.
// ---------------------------------------------------------------------------
async function noWarnTest() {
  process.env.MECH_COMPACT_WARN_GITIGNORE = "0";
  const mod = await jiti.import(EXT_PATH);
  const { handlers, pi } = loadExt();
  mod.default(pi);
  const { file: sessionFile, entries } = makeSessionFile();
  const msgEntries = entries.filter((x) => x.type === "message");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-nowarn-"));
  execFileSync("git", ["init", "-q"], { cwd: projectDir }); // no .gitignore
  const notifs = [];
  const ctx = {
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    ui: { notify: (m, k) => notifs.push(`${k || "info"}: ${m}`) },
    sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
    modelRegistry: {},
    model: undefined,
  };
  const preparation = {
    firstKeptEntryId: msgEntries.slice(-3)[0].id,
    messagesToSummarize: msgEntries.slice(0, -3).map((x) => x.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123456,
    previousSummary: undefined,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const result = await handlers.session_before_compact(
    { type: "session_before_compact", preparation, branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
    ctx,
  );
  assert(result && result.compaction, "compaction succeeded with the warning disabled");
  assert(fs.existsSync(path.join(projectDir, ".pi", "context-dumps")), "dump still written under the project");
  assert.strictEqual(notifs.filter((n) => n.includes("not git-ignored")).length, 0, "MECH_COMPACT_WARN_GITIGNORE=0 silences the warning");
  console.log("NOWARN TEST OK — un-ignored repo, warning suppressed, dump still written");
}

// ---------------------------------------------------------------------------
// Mode: dumpdir — MECH_COMPACT_DUMP_DIR redirects dumps outside the project.
// Runs as its own process because the override is read at module load.
// ---------------------------------------------------------------------------
async function dumpDirTest() {
  const override = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-dumpdir-"));
  process.env.MECH_COMPACT_DUMP_DIR = override;
  const mod = await jiti.import(EXT_PATH);
  const { handlers, tools, pi } = loadExt();
  mod.default(pi);
  const { file: sessionFile, entries } = makeSessionFile();
  const msgEntries = entries.filter((x) => x.type === "message");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "verbatim-compact-dumpdir-proj-"));
  const makeCtx = () => ({
    cwd: projectDir,
    mode: "tui",
    hasUI: true,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile },
    modelRegistry: {},
    model: undefined,
  });
  const preparation = {
    firstKeptEntryId: msgEntries.slice(-3)[0].id,
    messagesToSummarize: msgEntries.slice(0, -3).map((x) => x.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 123456,
    previousSummary: undefined,
    fileOps: { read: new Set(["src/foo.ts"]), written: new Set(), edited: new Set(["src/foo.ts"]) },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  const result = await handlers.session_before_compact(
    { type: "session_before_compact", preparation, branchEntries: entries, reason: "manual", willRetry: false, signal: new AbortController().signal },
    makeCtx(),
  );
  assert(result && result.compaction, "hook returned a compaction");
  const dumpDir = result.compaction.details.dumpDir;
  assert(dumpDir.startsWith(override + path.sep), "dump written under MECH_COMPACT_DUMP_DIR");
  assert(!fs.existsSync(path.join(projectDir, ".pi", "context-dumps")), "no dump written under the project");
  const dumpText = fs.readFileSync(path.join(dumpDir, "conversation.md"), "utf8");
  assert(dumpText.includes(MARKER_OUTPUT), "dump content intact under the override root");
  const meta = JSON.parse(fs.readFileSync(path.join(dumpDir, "meta.json"), "utf8"));
  assert.strictEqual(meta.cwd, projectDir, "meta still records the project cwd (scoping intact)");
  // Lookup resolves dumps from the override root.
  const stubRegistry = {
    complete: async (_model, context) => {
      const last = context.messages[context.messages.length - 1];
      if (last.role === "user")
        return {
          role: "assistant",
          content: [{ type: "text", text: "" }, { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "MARKER_TEST_OUTPUT" } }],
          stopReason: "stop",
          usage: {},
        };
      return { role: "assistant", content: [{ type: "text", text: "Finding: N=7 marker present (MARKER_TEST_OUTPUT)." }], stopReason: "stop", usage: {} };
    },
    find: () => undefined,
  };
  const ctxL = makeCtx();
  ctxL.model = { id: "test-model", provider: "test" };
  ctxL.modelRegistry = stubRegistry;
  const r = await tools.context_lookup.execute("tc", { question: "What did the test run output?" }, new AbortController().signal, undefined, ctxL);
  assert(r.content[0].text.includes("Finding:"), "lookup found the dump under the override root");
  console.log(`DUMPDIR TEST OK — dumps redirected to ${override}, lookup resolves them`);
}

const fail = (err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
};
const mode = process.argv[2] || "full";
if (mode === "cap")
  capTest()
    .then(() => capHangTest())
    .then(() => process.exit(0))
    .catch(fail);
else if (mode === "caphang") {
  process.env.MECH_COMPACT_MAX_SUMMARY_CHARS = "3000"; // deterministic small budget
  capHangTest().then(() => process.exit(0)).catch(fail);
} else if (mode === "capspans") {
  capSpansTest().then(() => process.exit(0)).catch(fail);
} else if (mode === "dumpdir") {
  dumpDirTest().then(() => process.exit(0)).catch(fail);
} else if (mode === "nowarn") {
  noWarnTest().then(() => process.exit(0)).catch(fail);
} else
  fullTest()
    .then(() => process.exit(0))
    .catch(fail);
