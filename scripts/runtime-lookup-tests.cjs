"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Real SDK AgentSession + extension loader + tool pipeline. Only model transport
// and auth are stubbed; persistence ordering is owned by Pi, not this test.
module.exports = async function runtimeLookupTests(h) {
  const { jiti, piRoot, root, SessionManager, assistant, text, toolCall, toolText } = h;
  const { createAgentSession, ModelRuntime, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
  const { Type } = await jiti.import("typebox");
  const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
  console.log("== Real Pi turns: assistant persistence, narration, same-batch limits, and parallel compatibility ==");
  for (const sequential of [true, false]) {
    const manager = SessionManager.inMemory(root);
    const loaded = await loadExtensions([path.resolve(__dirname, "../source/extensions/verbatim-compact.ts")], root);
    assert.deepEqual(loaded.errors, []);
    const definition = loaded.extensions[0].tools.get("context_lookup").definition;
    assert.equal(definition.executionMode, "sequential");
    if (!sequential) delete definition.executionMode; // Emulate a runtime ignoring this override.
    const observed = [];
    const original = definition.execute;
    definition.execute = async (id, args, signal, onUpdate, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      assert(branch.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((b) => b.type === "toolCall" && b.id === id)), "Pi persists the assistant tool-call message before execute");
      const result = await original(id, args, signal, onUpdate, ctx);
      observed.push([id, toolText(result)]);
      return result;
    };
    const loader = {
      getExtensions: () => loaded,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Deterministic regression test.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const runtime = await ModelRuntime.create({ authPath: path.join(root, "runtime-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({ auth: { apiKey: "test-only-no-network" } });
    let subagentCalls = 0;
    const lookupSessionIds = [];
    runtime.complete = async (_model, _context, options) => {
      assert(!Object.hasOwn(options, "cacheRetention"));
      assert.notEqual(options.sessionId, manager.getSessionId());
      lookupSessionIds.push(options.sessionId);
      subagentCalls++;
      return assistant([text("Runtime findings.")]);
    };
    const lookup = (id) => toolCall("context_lookup", { question: "Recover prior evidence" }, id);
    const grep = (id) => toolCall("context_grep", { pattern: "prior evidence", before: 0, after: 0 }, id);
    const work = (id) => toolCall("ordinary_work", {}, id);
    const scripted = [
      assistant([text("Not found yet, let me check twice."), lookup("a"), lookup("b")], "toolUse"),
      assistant([text("Let me narrate and try again."), lookup("c")], "toolUse"),
      assistant([grep("fallback")], "toolUse"),
      assistant([lookup("d")], "toolUse"),
      ...(sequential ? [assistant([grep("between"), lookup("e")], "toolUse")] : []),
      assistant([work("reset")], "toolUse"),
      assistant([lookup("f")], "toolUse"),
      ...(sequential ? [assistant([work("same-batch-reset"), lookup("g")], "toolUse")] : []),
      assistant([text("Done.")]),
    ];
    let turns = 0;
    runtime.streamSimple = () => {
      const message = scripted[turns++];
      assert(message, "unexpected extra model turn");
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    };
    const model = { id: "stub-model", provider: "stub", api: "test", name: "Test model", baseUrl: "http://127.0.0.1:1/never", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, modelRuntime: runtime, model, resourceLoader: loader,
      sessionManager: manager, tools: ["context_lookup", "context_grep", "ordinary_work"], thinkingLevel: "off",
      customTools: [{ name: "ordinary_work", label: "Ordinary work", description: "Test-only recovery boundary", parameters: Type.Object({}),
        execute: async () => ({ content: [text("Ordinary work done")], details: undefined }),
      }],
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }),
    });
    try {
      await session.bindExtensions({ mode: "json", onError: (error) => { throw new Error(JSON.stringify(error)); } });
      session.agent.toolExecution = "parallel";
      await session.prompt("Recover prior evidence.");
      assert.equal(turns, scripted.length);
      const results = new Map(observed);
      assert.equal(results.get("a"), "Runtime findings.");
      assert(results.get("b")?.includes("consecutive-call limit reached"));
      assert(results.get("c")?.includes("consecutive-call limit reached"), "narration cannot reset the cap");
      assert(results.get("d")?.includes("consecutive-call limit reached"), "fallback result does not reset the recovery episode");
      if (sequential) assert(results.get("e")?.includes("consecutive-call limit reached"), "same-message fallback search does not reset the streak either");
      assert.equal(results.get("f"), "Runtime findings.", "ordinary-work result resets the streak");
      if (sequential) assert.equal(results.get("g"), "Runtime findings.", "ordinary work between same-message calls is a boundary");
      assert.equal(subagentCalls, sequential ? 3 : 2);
      assert.equal(new Set(lookupSessionIds).size, subagentCalls, "independent lookups have separate cache identities");
      const persisted = manager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "context_lookup");
      assert.equal(persisted.length, observed.length);
      for (const e of persisted) assert.equal(toolText(e.message), results.get(e.message.toolCallId));
    } finally {
      session.dispose();
    }
  }
};
