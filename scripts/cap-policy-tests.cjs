"use strict";

// Cap-policy integration tests for the maintained release; no live model calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function capPolicyTests({ factory, SessionManager, root, load, makeContext, compact, saveSession, user }) {
  console.log("== Cap policy: modes, budgets, dialogs, cancellation, and branch persistence ==");
  const cwd = path.join(root, "cap-policy-project");
  fs.mkdirSync(cwd);
  const huge = "CAP_POLICY_CONTENT ".repeat(12000) + "CAP_POLICY_END";
  const make = (content = huge) => {
    const manager = SessionManager.inMemory(cwd);
    const u = manager.appendMessage(user(content));
    const kept = manager.appendMessage(user("Retained tail"));
    const ref = { current: manager };
    const ext = load(factory, ref);
    const notices = [];
    const ctx = { ...makeContext(manager, cwd), model: { contextWindow: 192000 }, ui: {
      notify: (message, level) => notices.push({ message, level }),
    } };
    return { manager, u, kept, ref, ext, notices, ctx, command: ext.commands["cap-compaction"] };
  };
  const set = (f, args) => f.command.handler(args, f.ctx);
  const attempt = (f, reason = "manual", signal = new AbortController().signal) => {
    const preparation = { messagesToSummarize: [f.manager.getEntry(f.u).message], turnPrefixMessages: [],
      firstKeptEntryId: f.kept, tokensBefore: 123456, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
    return f.ext.handlers.session_before_compact({ preparation, branchEntries: f.manager.getBranch(), reason, signal }, f.ctx);
  };
  const normalise = (summary) => summary.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>");
  const latest = (f) => f.notices.at(-1).message;
  const interactive = (f, select, input) => {
    f.ctx.hasUI = true;
    f.ctx.mode = "tui";
    f.ctx.ui.select = select;
    if (input) f.ctx.ui.input = input;
  };

  const defaults = make();
  const initialLeaf = defaults.manager.getLeafId();
  const initialContext = JSON.stringify(defaults.manager.buildSessionContext());
  await set(defaults, "");
  assert(latest(defaults).includes("cap: warn; budget 80000c"));
  assert.equal(defaults.manager.getLeafId(), initialLeaf, "status does not persist state");
  assert.deepEqual(defaults.command.getArgumentCompletions("w").map((x) => x.value), ["warn"]);
  assert.deepEqual(defaults.command.getArgumentCompletions("warn 2").map((x) => x.value), ["warn 20000t", "warn 25%"]);
  for (const args of ["invalid", "on extra", "on 10c extra", "0c", "-1t", "1.5t", "0%", "101%", "Infinity%", "NaNc", "20000", "9007199254740992c", "9007199254740991t"]) {
    await set(defaults, args);
    assert.equal(defaults.notices.at(-1).level, "error", `reject ${args}`);
    assert.equal(defaults.manager.getLeafId(), initialLeaf, "invalid args do not write state");
  }
  const fallback = await attempt(defaults);
  assert(fallback.compaction && !fallback.compaction.summary.includes(huge));
  assert(defaults.notices.some((n) => n.level === "warning" && n.message.includes("no interactive UI")));
  await set(defaults, "on 80000c");
  const explicit = await attempt(defaults);
  assert.equal(normalise(explicit.compaction.summary), normalise(fallback.compaction.summary), "80000c preserves the original budget/scope/trimming exactly");
  assert.equal(JSON.stringify(defaults.manager.buildSessionContext()), initialContext, "cap settings stay out of model context");
  const onLeaf = defaults.manager.getLeafId();
  await set(defaults, "on");
  await set(defaults, "");
  assert.equal(defaults.manager.getLeafId(), onLeaf, "identical settings and status do not duplicate state");
  await set(defaults, "on 20000t");
  assert.equal(normalise((await attempt(defaults)).compaction.summary), normalise(explicit.compaction.summary), "20000 estimated tokens equals 80000c");
  await set(defaults, "25%");
  assert(latest(defaults).includes("48,000 estimated tokens; 192,000 chars"));
  assert(!(await attempt(defaults)).compaction.summary.includes(huge));
  defaults.ctx.model.contextWindow = 384000;
  await set(defaults, "");
  assert(latest(defaults).includes("96,000 estimated tokens; 384,000 chars"));
  assert((await attempt(defaults)).compaction.summary.includes(huge), "percentage recalculates after model changes");
  defaults.ctx.model.contextWindow = 192001;
  await set(defaults, "12.5%");
  assert(latest(defaults).includes("24,000 estimated tokens; 96,000 chars"), "fractional percentages round down to whole tokens");

  const small = make("Small span");
  interactive(small, () => assert.fail("no prompt unless content would actually be trimmed"));
  assert((await attempt(small)).compaction.summary.includes("Small span"));

  for (const reason of ["manual", "threshold", "overflow"]) {
    const f = make();
    const signal = new AbortController().signal;
    let dialogs = 0;
    interactive(f, async (title, choices, opts) => {
      dialogs++;
      assert.equal(opts.signal, signal);
      assert(title.includes("would trim content"));
      if (reason === "overflow") assert(title.includes("Overflow recovery"));
      assert.deepEqual(choices, ["Apply trimming", "Disable cap for this session", "Change budget", "Cancel compaction"]);
      return "Apply trimming";
    });
    const result = await attempt(f, reason, signal);
    assert.equal(dialogs, 1);
    assert(result.compaction && !result.compaction.summary.includes(huge));
    assert(result.compaction.details.span.lines[0].includes(huge), "trimming never destroys stored span contents");
    f.notices.length = 0;
    await set(f, "on");
    interactive(f, () => assert.fail("on mode never prompts"));
    assert((await attempt(f, reason)).compaction);
    assert(!f.notices.some((n) => n.message.includes("would trim content")), "on is silent about cap trimming");
  }

  const bypass = make();
  let bypassDialogs = 0;
  interactive(bypass, async () => { bypassDialogs++; return "Disable cap for this session"; });
  const first = await compact(bypass.ext, bypass.ctx, [bypass.u], bypass.kept);
  assert(first.summary.includes(huge));
  await set(bypass, "");
  assert(latest(bypass).includes("cap: off; budget 80000c"));
  const nextTail = bypass.manager.appendMessage(user("Next tail"));
  const second = await compact(bypass.ext, bypass.ctx, [bypass.kept], nextTail, "threshold");
  assert(second.summary.includes(huge), "the next compaction does not recap a bypassed span");
  assert.equal(bypassDialogs, 1, "bypass turns the cap off persistently");
  const saved = path.join(root, "cap-policy-session.jsonl");
  saveSession(bypass.manager, saved);
  for (const manager of [SessionManager.open(saved), SessionManager.forkFrom(saved, cwd, path.join(root, "cap-policy-forks"))]) {
    const ref = { current: manager };
    const ext = load(factory, ref);
    const ctx = { ...bypass.ctx, sessionManager: manager };
    await ext.handlers.session_start({ reason: "resume" }, ctx);
    await ext.commands["cap-compaction"].handler("", ctx);
    assert(latest(bypass).includes("cap: off; budget 80000c"), "resume/reload/fork preserve cap state");
  }
  bypass.manager.branch(bypass.kept);
  await set(bypass, "");
  assert(latest(bypass).includes("cap: warn; budget 80000c"), "navigation before a choice restores the earlier policy");
  await set(bypass, "off 25%");
  await set(bypass, "80000c");
  assert(latest(bypass).includes("cap: off; budget 80000c"), "budget-only input preserves mode");
  await set(bypass, "warn");
  assert(latest(bypass).includes("cap: warn; budget 80000c"), "mode-only input preserves budget");

  const changed = make();
  let inputCalls = 0, changeDialogs = 0;
  interactive(changed, async () => { changeDialogs++; return "Change budget"; }, async (_title, placeholder, opts) => {
    assert.equal(placeholder, "80000c");
    assert(opts.signal);
    return ++inputCalls === 1 ? "wrong" : "400000c";
  });
  assert((await attempt(changed)).compaction.summary.includes(huge));
  assert.equal(changeDialogs, 1);
  assert.equal(inputCalls, 2, "invalid prompt budget is retried without silently applying the old cap");
  await set(changed, "");
  assert(latest(changed).includes("cap: warn; budget 400000c"));
  interactive(changed, () => assert.fail("raised budget persists without another prompt"));
  assert((await attempt(changed)).compaction.summary.includes(huge));

  const lowered = make();
  const choices = ["Change budget", "Apply trimming"];
  interactive(lowered, async () => choices.shift(), async () => "3000c");
  assert(!(await attempt(lowered)).compaction.summary.includes(huge));
  assert.equal(choices.length, 0, "changed budget is rechecked before any trimming");

  for (const selection of ["Cancel compaction", undefined]) {
    const f = make();
    const leaf = f.manager.getLeafId();
    interactive(f, async () => selection);
    assert.deepEqual(await attempt(f), { cancel: true });
    assert.equal(f.manager.getLeafId(), leaf, "cancel/Esc neither compacts nor persists a cap choice");
  }
  const cancelInput = make();
  interactive(cancelInput, async () => "Change budget", async () => undefined);
  const cancelLeaf = cancelInput.manager.getLeafId();
  assert.deepEqual(await attempt(cancelInput), { cancel: true });
  assert.equal(cancelInput.manager.getLeafId(), cancelLeaf);
  for (const stage of ["select", "input"]) {
    const aborted = make();
    const controller = new AbortController();
    interactive(aborted, async () => {
      if (stage === "select") controller.abort();
      return stage === "select" ? "Disable cap for this session" : "Change budget";
    }, async () => { controller.abort(); return "400000c"; });
    const leaf = aborted.manager.getLeafId();
    assert.deepEqual(await attempt(aborted, "manual", controller.signal), { cancel: true });
    assert.equal(aborted.manager.getLeafId(), leaf, "abort does not persist the unfinished dialog choice");
  }
  const brokenUI = make();
  interactive(brokenUI, async () => { throw new Error("dialog failed"); });
  assert.deepEqual(await attempt(brokenUI), { cancel: true }, "UI failure never falls through to summary compaction");

  const rpc = make();
  interactive(rpc, async () => "Apply trimming");
  rpc.ctx.mode = "rpc";
  assert((await attempt(rpc)).compaction, "supported RPC dialogs work without a custom TUI");
  const unknown = make();
  unknown.ctx.model = undefined;
  await set(unknown, "warn 25%");
  assert(latest(unknown).includes("context window unavailable"));
  assert.deepEqual(await attempt(unknown), { cancel: true }, "an unresolved percentage never silently falls back to summary or another cap");
  await set(unknown, "off");
  assert((await attempt(unknown)).compaction.summary.includes(huge), "off works even when percentage cannot be resolved");

  const summary = make();
  await set(summary, "warn 25%");
  summary.ctx.model = undefined;
  interactive(summary, () => assert.fail("summary method does not consult verbatim cap policy"));
  await summary.ext.commands["compaction-method"].handler("summary", summary.ctx);
  assert.equal(await attempt(summary), undefined);

  const protectedBase = make("Small new span");
  protectedBase.manager.appendCompaction("OPAQUE_BASE_".repeat(9000), protectedBase.kept, 1000);
  interactive(protectedBase, () => assert.fail("base-only overflow without line trimming needs no trim prompt"));
  await set(protectedBase, "warn 80000c");
  const baseResult = await attempt(protectedBase);
  assert(baseResult.compaction.summary.includes("OPAQUE_BASE_".repeat(9000)), "opaque bases remain uncapped");
  assert(protectedBase.notices.some((n) => n.message.includes("base block alone")));

  const fresh = make("Fresh session");
  await set(fresh, "");
  assert(latest(fresh).includes("cap: warn; budget 80000c"));
  assert.deepEqual(fs.readdirSync(cwd), [], "cap state adds no local files");
};

module.exports.defaultBudgetTests = async function ({ factory, SessionManager, root, load, makeContext, user }) {
  console.log("== Default cap: warn 25%, without a character environment override ==");
  const manager = SessionManager.inMemory(root);
  const content = "DEFAULT_PERCENT_CAP ".repeat(12000);
  const u = manager.appendMessage(user(content));
  const kept = manager.appendMessage(user("Retained tail"));
  const ext = load(factory, { current: manager });
  const notices = [];
  let prompts = 0;
  const ctx = { ...makeContext(manager, root), hasUI: true, mode: "tui", model: { contextWindow: 192000 }, ui: {
    notify: (message, level) => notices.push({ message, level }),
    select: async (title) => {
      prompts++;
      assert(title.includes("budget 25% (192,000 chars)"));
      return "Apply trimming";
    },
  } };
  const command = ext.commands["cap-compaction"];
  const leaf = manager.getLeafId();
  await command.handler("", ctx);
  assert(notices.at(-1).message.includes("cap: warn; budget 25% (48,000 estimated tokens; 192,000 chars)"));
  assert.equal(manager.getLeafId(), leaf, "fresh defaults require no saved state");
  const attempt = () => ext.handlers.session_before_compact({ reason: "manual", branchEntries: manager.getBranch(),
    signal: new AbortController().signal, preparation: { messagesToSummarize: [manager.getEntry(u).message],
      turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 123456 } }, ctx);
  assert(!(await attempt()).compaction.summary.includes(content));
  assert.equal(prompts, 1);
  ctx.model.contextWindow = 384000;
  assert((await attempt()).compaction.summary.includes(content));
  assert.equal(prompts, 1, "model switch grows the percentage budget without modifying session state");
  ctx.model = undefined;
  assert.deepEqual(await attempt(), { cancel: true });
  await command.handler("on 80000c", ctx);
  assert(!(await attempt()).compaction.summary.includes(content), "explicit character budget also works without a model");
  await command.handler("off", ctx);
  assert((await attempt()).compaction.summary.includes(content));
};

module.exports.envBudgetTests = async function ({ factory, SessionManager, root, load, makeContext, user, expectedBudget }) {
  console.log(`== Environment cap: percent=${process.env.MECH_COMPACT_MAX_SUMMARY_PERCENT}, chars=${process.env.MECH_COMPACT_MAX_SUMMARY_CHARS ?? "unset"}, expected ${expectedBudget} ==`);
  assert(/^(\d+(?:\.\d+)?)(%|c)$/.test(expectedBudget), "test must supply an explicit expected budget");
  const manager = SessionManager.inMemory(root);
  const u = manager.appendMessage(user("ENV_CAP_TEXT ".repeat(26000)));
  const kept = manager.appendMessage(user("Retained tail"));
  const ext = load(factory, { current: manager });
  const notices = [];
  const ctx = { ...makeContext(manager, root), model: { contextWindow: 192000 }, ui: {
    notify: (message, level) => notices.push({ message, level }),
  } };
  const command = ext.commands["cap-compaction"];
  const leaf = manager.getLeafId();
  await command.handler("", ctx);
  assert(notices.at(-1).message.includes(`cap: warn; budget ${expectedBudget} (`));
  assert.equal(manager.getLeafId(), leaf, "environment configuration does not create session state");
  const isPercent = expectedBudget.endsWith("%");
  const value = Number(expectedBudget.slice(0, -1));
  if (isPercent) {
    const tokens = Math.floor(192000 * value / 100);
    assert(notices.at(-1).message.includes(`${tokens.toLocaleString()} estimated tokens; ${(tokens * 4).toLocaleString()} chars`));
    ctx.model.contextWindow = 384000;
    await command.handler("", ctx);
    const switchedTokens = Math.floor(384000 * value / 100);
    assert(notices.at(-1).message.includes(`${switchedTokens.toLocaleString()} estimated tokens`), "environment percentages still follow model switches");
  } else {
    ctx.model = undefined;
    await command.handler("", ctx);
    assert(notices.at(-1).message.includes(`${value.toLocaleString()} chars`), "explicit chars override percent without needing a model");
  }
  // Defaults are captured on load, not reread from the environment at every use.
  process.env.MECH_COMPACT_MAX_SUMMARY_PERCENT = "75";
  await command.handler("", ctx);
  assert(notices.at(-1).message.includes(`budget ${expectedBudget} (`));
  await command.handler("warn 10%", ctx);
  assert(notices.at(-1).message.includes("budget 10% ("), "session settings override either environment unit");
  await command.handler("on 20000c", ctx);
  ctx.model = undefined;
  const result = await ext.handlers.session_before_compact({ reason: "manual", branchEntries: manager.getBranch(),
    signal: new AbortController().signal, preparation: { messagesToSummarize: [manager.getEntry(u).message],
      turnPrefixMessages: [], firstKeptEntryId: kept, tokensBefore: 123456 } }, ctx);
  assert(result.compaction, "session character override compacts normally regardless of the environment defaults");
};
