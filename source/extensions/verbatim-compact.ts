/**
 * verbatim-compact — verbatim compaction with session-backed recovery.
 *
 * Builds a deterministic checkpoint without writing local transcript dumps. context_lookup renders the current raw
 * session branch in memory at call time, including earlier compactions,
 * thinking, full tool outputs, and tool-call arguments. Pi normally persists
 * this history under ~/.pi/agent/sessions/; custom session locations and
 * ephemeral sessions work too. Only the active branch is searched.
 *
 * Does not register dump_context or /dump-context, and does not read, write,
 * or prune old dumps.
 *
 * Optional env settings:
 *   MECH_COMPACT_MAX_SUMMARY_CHARS    initial character budget override (takes precedence over percent)
 *   MECH_COMPACT_MAX_SUMMARY_PERCENT  initial percentage of model context (default 25; >0, <=100)
 *   MECH_COMPACT_LOOKUP_MODEL         "provider/modelId" for the lookup subagent
 *   MECH_COMPACT_LOOKUP_TURNS         max search turns (default 10), plus one
 *                                    final write-up when the budget is exhausted
 *   MECH_COMPACT_LOOKUP_SESSION_FILE  absolute session JSONL path to search
 *                                    instead of the current branch (study override)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { contentText, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import type { Message as AiMessage, Model, Tool as AiTool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Configuration
// ============================================================================

const MECH_KIND = "mech-compact";
const METHOD_ENTRY = "verbatim-compact:compaction-method";
type CompactionMethod = "verbatim" | "summary";

const SUMMARY_COMPACTION_WARNING = "Applying summary compaction weakens the verbatim guarantee. You may switch back to verbatim compaction before summary compaction runs to leave the guarantee unchanged. If summary compaction runs (manually or automatically), it replaces older active context with a model-generated summary, which may omit or reinterpret details. Switching back afterward does not undo this: only subsequent verbatim spans retain the guarantee. Original history remains recoverable through context_lookup, but is no longer a direct expansion of the active context.";
const MIXED_CONTEXT_WARNING = "**Mixed context: earlier material is model-summarized, not verbatim.** The verbatim guarantee applies only to the labelled verbatim spans and uncompacted tail. The model-summary base may omit or reinterpret details; use `context_lookup` to recover original history.";

// Read from the active branch rather than cached state: reload, resume, fork,
// and tree navigation all inherit only the choices on their own path.
function compactionMethod(entries: SessionEntry[]): CompactionMethod {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== METHOD_ENTRY) continue;
    const method = (entry.data as { method?: unknown } | undefined)?.method;
    if (method === "verbatim" || method === "summary") return method;
  }
  return "verbatim";
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function percentFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

const cfg = {
  defaultCapBudget: (process.env.MECH_COMPACT_MAX_SUMMARY_CHARS
    ? { unit: "chars", value: intFromEnv("MECH_COMPACT_MAX_SUMMARY_CHARS", 80_000) }
    : { unit: "percent", value: percentFromEnv("MECH_COMPACT_MAX_SUMMARY_PERCENT", 25) }) as CapBudget,
  lookupTurns: intFromEnv("MECH_COMPACT_LOOKUP_TURNS", 10),
  lookupModel: process.env.MECH_COMPACT_LOOKUP_MODEL?.trim() || undefined,
  argSnippetChars: 160,
  grepMaxChars: 12_000,
  showEntryMaxChars: 24_000,
  lookupAnswerMaxChars: 12_000,
};

// Cap policy is session/branch state, separate from the compaction method.
const CAP_ENTRY = "verbatim-compact:cap-compaction";
type CapMode = "on" | "off" | "warn";
interface CapBudget { unit: "chars" | "tokens" | "percent"; value: number }
interface CapSettings { mode: CapMode; budget: CapBudget }

function validCapBudget(value: unknown): value is CapBudget {
  if (!value || typeof value !== "object") return false;
  const { unit, value: n } = value as CapBudget;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return false;
  if (unit === "percent") return n <= 100;
  return Number.isSafeInteger(n) && (unit === "chars" || (unit === "tokens" && n <= Number.MAX_SAFE_INTEGER / 4));
}

function parseCapBudget(text: string): CapBudget | undefined {
  const match = /^(\d+(?:\.\d+)?)(c|t|%)$/.exec(text);
  if (!match) return;
  const budget: CapBudget = { value: Number(match[1]), unit: match[2] === "c" ? "chars" : match[2] === "t" ? "tokens" : "percent" };
  return validCapBudget(budget) ? budget : undefined;
}

function capSettings(entries: SessionEntry[]): CapSettings {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== CAP_ENTRY) continue;
    const state = entry.data as CapSettings | undefined;
    if (state && ["on", "off", "warn"].includes(state.mode) && validCapBudget(state.budget)) return state;
  }
  return { mode: "warn", budget: { ...cfg.defaultCapBudget } };
}

function capBudgetText(budget: CapBudget): string {
  return `${budget.value}${budget.unit === "chars" ? "c" : budget.unit === "tokens" ? "t" : "%"}`;
}

function capBudgetChars(budget: CapBudget, contextWindow?: number): number | undefined {
  if (budget.unit === "chars") return budget.value;
  if (budget.unit === "tokens") return budget.value * 4;
  if (!contextWindow || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const tokens = Math.max(1, Math.floor(contextWindow * budget.value / 100));
  return tokens <= Number.MAX_SAFE_INTEGER / 4 ? tokens * 4 : undefined;
}

function capDescription(state: CapSettings, contextWindow?: number): string {
  const chars = capBudgetChars(state.budget, contextWindow);
  const resolved = chars === undefined ? "model context window unavailable" : state.budget.unit === "chars"
    ? `${chars.toLocaleString()} chars`
    : `${(chars / 4).toLocaleString()} estimated tokens; ${chars.toLocaleString()} chars`;
  return `Verbatim compaction cap: ${state.mode}; budget ${capBudgetText(state.budget)} (${resolved}).`;
}

function persistCap(pi: ExtensionAPI, previous: CapSettings, next: CapSettings): void {
  if (previous.mode !== next.mode || previous.budget.unit !== next.budget.unit || previous.budget.value !== next.budget.value)
    pi.appendEntry(CAP_ENTRY, next);
}

// undefined means uncapped; null means cancel (never fall through to summary).
async function chooseCapBudget(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal | undefined,
  reason: string, size: { overhead: number; lineChars: number }): Promise<number | undefined | null> {
  try {
    let state = capSettings(ctx.sessionManager.getBranch());
    for (;;) {
      if (signal?.aborted) return null;
      if (state.mode === "off") return undefined;
      const limit = capBudgetChars(state.budget, ctx.model?.contextWindow);
      if (limit === undefined) {
        ctx.ui.notify("verbatim-compact: cannot resolve percentage cap without the model's context window; choose a c/t budget or turn the cap off.", "error");
        return null;
      }
      // Exactly the existing cap's test, including its minimum 500-char line budget.
      const needsTrim = size.lineChars > Math.max(500, limit - size.overhead);
      if (state.mode !== "warn" || !needsTrim) return limit;
      const warning = `Verbatim compaction would trim content: ~${(size.overhead + size.lineChars).toLocaleString()} conversation-section chars; budget ${capBudgetText(state.budget)} (${limit.toLocaleString()} chars).`;
      if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
        ctx.ui.notify(`${warning} Applying the cap because no interactive UI is available.`, "warning");
        return limit;
      }
      const risk = reason === "overflow"
        ? "Overflow recovery: disabling the cap may leave too much context for the retry."
        : "Disabling the cap may leave too much context for the model.";
      const choice = await ctx.ui.select(`${warning}\n${risk}`, [
        "Apply trimming", "Disable cap for this session", "Change budget", "Cancel compaction",
      ], { signal });
      if (signal?.aborted) return null;
      if (choice === "Apply trimming") return limit;
      if (choice === "Disable cap for this session") {
        const next: CapSettings = { ...state, mode: "off" };
        persistCap(pi, state, next);
        ctx.ui.notify(capDescription(next, ctx.model?.contextWindow), "info");
        return undefined;
      }
      if (choice !== "Change budget") return null;
      for (;;) {
        if (typeof ctx.ui.input !== "function") return null;
        const input = await ctx.ui.input("Compaction budget: <chars>c, <estimated tokens>t, or <context window>%", capBudgetText(state.budget), { signal });
        if (signal?.aborted || input === undefined) return null;
        const budget = parseCapBudget(input.trim());
        if (!budget) {
          ctx.ui.notify("Invalid budget: use a positive integer with c/t, or a percentage greater than 0 and at most 100% (e.g. 80000c, 20000t, 25%).", "error");
          continue;
        }
        const next = { ...state, budget };
        persistCap(pi, state, next);
        state = next;
        ctx.ui.notify(capDescription(state, ctx.model?.contextWindow), "info");
        break; // Recheck: a smaller/new budget may still require trimming.
      }
    }
  } catch (err) {
    if (!signal?.aborted) ctx.ui?.notify?.(`verbatim-compact: unable to resolve cap decision (${errMsg(err)}); compaction cancelled`, "error");
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Content helpers
// ============================================================================

interface TextOut {
  text: string;
  images: number;
}

function textOf(content: unknown): TextOut {
  if (typeof content === "string") return { text: content, images: 0 };
  if (Array.isArray(content)) {
    let text = "";
    let images = 0;
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") text += block.text;
      else if (block && block.type === "image") images++;
    }
    if (images > 0) text += `\n[${images} image(s) attached — binary, not inlined in transcript]`;
    return { text, images };
  }
  return { text: "", images: 0 };
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n…[+${dropped} chars truncated]`;
}

// ============================================================================
// Transcript: full-fidelity branch serialization (untruncated, entry-anchored)
// ============================================================================

const HR = "=".repeat(78);

/**
 * Serialize one message into PHYSICAL lines (no element may contain \n, so
 * array positions map 1:1 to file lines) plus, for assistant messages, the
 * relative position of each section marker line.
 */
function serializeAgentMessage(msg: AgentMessage): { lines: string[]; sections?: { kind: string; rel: number }[] } {
  const m = msg as unknown as Record<string, any>;
  const lines: string[] = [];
  const sections: { kind: string; rel: number }[] = [];
  switch (msg.role) {
    case "user":
    case "toolResult": {
      const { text } = textOf(m.content);
      lines.push(...text.split("\n"));
      break;
    }
    case "assistant": {
      for (const block of m.content ?? []) {
        if (block.type === "thinking") {
          sections.push({ kind: "thinking", rel: lines.length });
          lines.push("[thinking]", ...String(block.thinking ?? "").split("\n"));
        } else if (block.type === "text") {
          sections.push({ kind: "text", rel: lines.length });
          lines.push("[text]", ...String(block.text ?? "").split("\n"));
        } else if (block.type === "toolCall") {
          sections.push({ kind: "toolCall", rel: lines.length });
          lines.push(`[toolCall] ${block.name}`, ...JSON.stringify(block.arguments ?? {}, null, 2).split("\n"));
        }
      }
      break;
    }
    case "bashExecution": {
      lines.push(...`$ ${String(m.command ?? "")}`.split("\n"), "[output]", ...String(m.output ?? "").split("\n"));
      break;
    }
    case "custom": {
      lines.push(...textOf(m.content).text.split("\n"));
      break;
    }
    default:
      lines.push(...JSON.stringify(msg, null, 2).split("\n"));
  }
  return sections.length > 0 ? { lines, sections } : { lines };
}

interface TranscriptIndexSection {
  kind: string;
  /** 1-based line number of the section marker line */
  startLine: number;
}

interface TranscriptIndexEntry {
  id: string;
  type: string;
  role?: string;
  /** 1-based line number of the ENTRY header line */
  startLine: number;
  /** 1-based line number of the last line of the block (inclusive) */
  endLine: number;
  sections?: TranscriptIndexSection[];
}

function branchToTranscript(entries: SessionEntry[]): { lines: string[]; index: TranscriptIndexEntry[] } {
  const lines: string[] = [
    "# pi session transcript — full raw branch",
    "# Each block starts with an ENTRY header; entry ids match the session JSONL.",
    "# Thinking blocks and tool outputs are complete (not truncated).",
    "",
  ];
  interface BlockRec {
    id: string;
    type: string;
    role?: string;
    hrIdx: number;
    sections?: { kind: string; rel: number }[];
  }
  const blocks: BlockRec[] = [];
  for (const entry of entries) {
    const t = (entry as { timestamp?: string }).timestamp ?? "";
    const hrIdx = lines.length;
    lines.push(HR);
    let role: string | undefined;
    let sections: { kind: string; rel: number }[] | undefined;
    switch (entry.type) {
      case "session": {
        const e = entry as SessionEntry & { version?: number; id?: string; cwd?: string; parentSession?: string };
        lines.push(`ENTRY <header>  session v${e.version ?? 1}  id=${e.id ?? "?"}`);
        lines.push(`  cwd=${e.cwd ?? "?"}${e.parentSession ? `  parentSession=${e.parentSession}` : ""}`);
        break;
      }
      case "message": {
        const m = entry.message as unknown as Record<string, any>;
        if (m.role === "system") {
          const sectionNames = m.sections ? Object.keys(m.sections).join(", ") : "(content only)";
          lines.push(`ENTRY ${entry.id}  system  ${t}`);
          lines.push(`  (system prompt checkpoint — sections: ${sectionNames}; full text in session JSONL)`);
          role = m.role;
        } else {
          const extra =
            m.role === "toolResult"
              ? ` (${m.toolName ?? "?"}, isError=${m.isError ? "true" : "false"})`
              : m.role === "assistant"
                ? ` (model=${m.provider ?? "?"}/${m.model ?? "?"}, stop=${m.stopReason ?? "?"})`
                : "";
          lines.push(`ENTRY ${entry.id}  ${m.role}${extra}  ${t}`);
          const ser = serializeAgentMessage(entry.message);
          lines.push(...ser.lines);
          role = m.role;
          sections = ser.sections;
        }
        break;
      }
      case "compaction": {
        const e = entry as SessionEntry & { tokensBefore?: number; firstKeptEntryId?: string; summary?: string; details?: { dumpDir?: string } };
        lines.push(`ENTRY ${entry.id}  compaction  ${t}  tokensBefore=${e.tokensBefore ?? "?"}  firstKeptEntryId=${e.firstKeptEntryId ?? "?"}`);
        if (e.details?.dumpDir) lines.push(`  previous dump: ${e.details.dumpDir}`);
        lines.push("[summary]");
        lines.push(...String(e.summary ?? "").split("\n"));
        break;
      }
      case "branch_summary": {
        const e = entry as SessionEntry & { fromId?: string; summary?: string };
        lines.push(`ENTRY ${entry.id}  branch_summary  ${t}  fromId=${e.fromId ?? "?"}`);
        lines.push(...String(e.summary ?? "").split("\n"));
        break;
      }
      case "custom_message": {
        const e = entry as SessionEntry & { customType?: string; content?: unknown };
        lines.push(`ENTRY ${entry.id}  custom_message (${e.customType ?? "?"})  ${t}`);
        lines.push(...textOf(e.content).text.split("\n"));
        break;
      }
      case "model_change":
        lines.push(`ENTRY ${entry.id}  model_change  ${t}  -> ${(entry as any).provider}/${(entry as any).modelId}`);
        break;
      case "thinking_level_change":
        lines.push(`ENTRY ${entry.id}  thinking_level_change  ${t}  -> ${(entry as any).thinkingLevel}`);
        break;
      case "usage":
        lines.push(`ENTRY ${entry.id}  usage (${(entry as any).kind ?? "?"})  ${t}  (not in LLM context)`);
        break;
      case "custom":
        lines.push(`ENTRY ${entry.id}  custom (${(entry as any).customType ?? "?"})  ${t}  (not in LLM context)`);
        break;
      case "label":
        lines.push(`ENTRY ${entry.id}  label  ${t}  target=${(entry as any).targetId}  label=${(entry as any).label ?? "(cleared)"}`);
        break;
      case "context_edit":
        lines.push(
          `ENTRY ${entry.id}  context_edit  ${t}  target=${(entry as any).targetId}  replacement=${(entry as any).replacement === null ? "omitted" : "replaced"}`,
        );
        break;
      case "session_info":
        lines.push(`ENTRY ${entry.id}  session_info  ${t}  name=${(entry as any).name ?? ""}`);
        break;
      default:
        lines.push(`ENTRY ${entry.id}  ${(entry as { type: string }).type}  ${t}  (unhandled entry type)`);
    }
    lines.push("");
    blocks.push({ id: entry.id, type: entry.type, role, hrIdx, sections });
  }
  const index: TranscriptIndexEntry[] = blocks.map((b, i) => {
    const e: TranscriptIndexEntry = {
      id: b.id,
      type: b.type,
      startLine: b.hrIdx + 2, // header line (1-based)
      endLine: i + 1 < blocks.length ? blocks[i + 1].hrIdx : lines.length, // last line of block, inclusive
    };
    if (b.role) e.role = b.role;
    if (b.sections && b.sections.length > 0) e.sections = b.sections.map((s) => ({ kind: s.kind, startLine: b.hrIdx + s.rel + 3 }));
    return e;
  });
  return { lines, index };
}

// ============================================================================
// Mechanical summary (what replaces the model summary in the session)
// ============================================================================

function toolCallSignature(name: string, args: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    let s: string;
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
    if (s.length > cfg.argSnippetChars) s = `${s.slice(0, cfg.argSnippetChars)}…[+${s.length - cfg.argSnippetChars} chars]`;
    parts.push(`${k}=${s}`);
  }
  return `${name}(${parts.join(", ")})`;
}

function summarizeMessages(messages: AgentMessage[]): string[] {
  const lines: string[] = [];
  for (const msg of messages) {
    const m = msg as unknown as Record<string, any>;
    switch (msg.role) {
      case "user": {
        const { text, images } = textOf(m.content);
        if (text.trim() || images > 0) lines.push(`[User]: ${text}`);
        break;
      }
      case "assistant": {
        let prose = "";
        const calls: string[] = [];
        for (const block of m.content ?? []) {
          if (block.type === "text") prose += (prose ? "\n" : "") + String(block.text ?? "");
          else if (block.type === "toolCall") calls.push(toolCallSignature(String(block.name), block.arguments));
          // thinking blocks: removed by design (kept in the session)
        }
        if (prose.trim()) lines.push(`[Assistant]: ${prose.trim()}`);
        if (calls.length > 0) lines.push(`[Assistant tool calls] (outputs removed): ${calls.join("; ")}`);
        break;
      }
      case "toolResult":
        // removed by design (kept in the session)
        break;
      case "bashExecution":
        lines.push(`[BashExecution]: $ ${String(m.command ?? "")}  (output removed — use context_lookup)`);
        break;
      case "custom":
        lines.push(`[Custom]: ${textOf(m.content).text}`);
        break;
      case "branchSummary":
      case "compactionSummary":
        lines.push(`[${msg.role === "branchSummary" ? "Branch summary" : "Compaction summary"}]: ${String(m.summary ?? "")}`);
        break;
      default:
        break;
    }
  }
  return lines;
}

const SECTION_HEADER = "### Compacted conversation (oldest first)";
const SPAN_CLOSE = "</compacted-span>";
const SPAN_TRIMMED_NOTE = "(trimmed for size — use context_lookup)";
const SPAN_TRIMMED_ATTR = ' trimmed="true"';
const BASE_CLOSE = "</compacted-base>";

function spanOpen(n: number, compactedAt: string, reason: string, covers?: string): string {
  // covers = [first summarised message, last summarised message]; the span
  // ends at pi's cut point, which is earlier than the compaction time.
  // Spans written before from/to existed render without covers.
  return `<compacted-span n="${n}"${covers ? ` covers="${covers}"` : ""} compacted-at="${compactedAt}" trigger="${reason}">`;
}

/**
 * The base = the most recent compaction entry on the branch that is NOT a
 * mech-compact entry with details.span — i.e. a model-generated summary or a
 * legacy (nested-format) mech checkpoint. Everything before it is covered by
 * its opaque summary text. Spans = mech entries with details.span after the
 * base, oldest first. Spans before the base are deliberately NOT re-rendered
 * (the base is opaque; the session holds the raw history).
 */
function collectBaseAndSpans(branchEntries: SessionEntry[]): {
  base: { kind: "model-summary" | "legacy-checkpoint"; at: string; summary: string } | null;
  spans: { at: string; reason: string; from?: string; to?: string; lines: string[] }[];
} {
  const spanDetails = (e: SessionEntry) => {
    if (e.type !== "compaction") return undefined;
    const d = (e as { details?: Record<string, any> }).details;
    if (!d || d.kind !== MECH_KIND || !Array.isArray(d.span?.lines)) return undefined;
    return d.span as { at?: unknown; reason?: unknown; from?: unknown; to?: unknown; lines: string[] };
  };
  let baseIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type !== "compaction") continue;
    if (!spanDetails(branchEntries[i])) {
      baseIdx = i;
      break;
    }
  }
  const baseEntry = baseIdx >= 0 ? branchEntries[baseIdx] : null;
  const base = baseEntry
    ? {
        kind: (((baseEntry as { details?: { kind?: string } }).details?.kind === MECH_KIND) as boolean ? "legacy-checkpoint" : "model-summary") as
          | "model-summary"
          | "legacy-checkpoint",
        at: (baseEntry as { timestamp?: string }).timestamp ?? "",
        summary: (baseEntry as { summary?: string }).summary ?? "",
      }
    : null;
  const spans: { at: string; reason: string; from?: string; to?: string; lines: string[] }[] = [];
  for (let i = Math.max(baseIdx + 1, 0); i < branchEntries.length; i++) {
    const sd = spanDetails(branchEntries[i]);
    if (sd)
      spans.push({
        at: String(sd.at ?? (branchEntries[i] as { timestamp?: string }).timestamp ?? ""),
        reason: String(sd.reason ?? "unknown"),
        // from/to are absent on spans written before they existed — render
        // without covers rather than guessing.
        from: typeof sd.from === "string" && sd.from !== "" ? sd.from : undefined,
        to: typeof sd.to === "string" && sd.to !== "" ? sd.to : undefined,
        lines: sd.lines,
      });
  }
  return { base, spans };
}

/**
 * Size guard across ordered spans (oldest first): if the total line budget is
 * exceeded, (1) drop the oldest non-user lines, (2) stub each oversized user
 * line at most once in a single forward pass (never re-stub → no loops),
 * (3) drop the oldest remaining lines until under budget. Everything dropped
 * remains in the session.
 */
function capSpans(spans: string[][], budget: number): string[][] {
  const items: { span: number; line: string }[] = spans.flatMap((lines, span) => lines.map((line) => ({ span, line })));
  let size = items.reduce((a, it) => a + it.line.length + 1, 0);
  const over = () => size > budget;
  const remove = (i: number) => {
    size -= items[i].line.length + 1;
    items.splice(i, 1);
  };

  // 1) drop oldest non-user lines (flat order = span order = oldest first;
  //    terminates: each pass removes a line or advances i)
  for (let i = 0; i < items.length && over(); ) {
    if (items[i].line.startsWith("[User]:")) i++;
    else remove(i);
  }
  // 2) stub user lines, oldest first, each at most once (terminates: single forward pass)
  for (let i = 0; i < items.length && over(); i++) {
    const line = items[i].line;
    if (!line.startsWith("[User]:") || line.length <= 120) continue;
    const stub = `${line.slice(0, 120)}…[truncated +${line.length - 120} chars — use context_lookup]`;
    if (stub.length >= line.length) continue; // stubbing would not shrink it; step 3 drops it
    size += stub.length - line.length;
    items[i] = { ...items[i], line: stub };
  }
  // 3) drop oldest remaining lines until under budget (terminates: removes one per iteration)
  while (over() && items.length > 0) remove(0);

  return spans.map((_, span) => items.filter((it) => it.span === span).map((it) => it.line));
}

const REORIENT_BLOCK = `**Re-orient before continuing.** Compaction may have removed information needed to follow the project instructions:
1. Re-read documents required by the applicable instructions (such as files referenced by AGENTS.md / CLAUDE.md), even if you read them before compaction. Re-acquire any other information needed for the current task that is no longer in context. This means restoring inputs, not repeating completed work: do not redo writes, edits, or other state-changing actions merely because their results were dropped. If needed, recover those results with \`context_lookup\`, or verify current state.
2. If this is a Git repository, run \`git status\` and review uncommitted work. Re-verify build/test state if you are about to rely on it.
3. Re-read any file you are about to modify — do not trust content you only remember from before the compaction.
4. **Treat other pre-compaction knowledge as unverified too.** Thinking and tool outputs were removed. Anything you know only from them — or from earlier assistant prose describing them — is a note, not evidence. Before you state it as fact or base a decision on it, re-read the source or ask \`context_lookup\`. If you cannot verify it, say explicitly that it is unverified.

**Recovering dropped details.** Information removed from your active context is preserved in the session. Use \`context_lookup\` to recover relevant details, including earlier thinking and tool outputs. Do NOT grep the session file yourself in this conversation — that would fill your context with raw transcript text. Call the \`context_lookup\` tool with a specific question; a subagent searches the session transcript in its own context and returns only the relevant findings.`;

async function buildMechanicalSummary(opts: {
  reason: string; // pi's raw reason: "manual" | "threshold" | "overflow"
  tokensBefore: number;
  branchEntries: SessionEntry[];
  now: string;
  spanLines: string[]; // this compaction's own span, un-capped
  spanFrom?: string; // ISO timestamp of the first summarised message
  spanTo?: string; // ISO timestamp of the last summarised message
  firstKeptEntryId?: string; // start of the verbatim (uncompacted) tail
  readFiles: string[];
  modifiedFiles: string[];
  notify: (msg: string) => void;
  chooseCap: (size: { overhead: number; lineChars: number }) => Promise<number | undefined | null>;
}): Promise<string | undefined> {
  const { base, spans } = collectBaseAndSpans(opts.branchEntries);
  const allSpans = [...spans, { at: opts.now, reason: opts.reason, from: opts.spanFrom, to: opts.spanTo, lines: opts.spanLines }];
  const coversOf = (s: { from?: string; to?: string }): string | undefined => (s.from && s.to ? `${s.from} → ${s.to}` : undefined);

  // Size guard: the budget applies to the WHOLE conversation section (base +
  // all spans). The fixed tag overhead is computed exactly (tags are known
  // strings), so the rendered section is guaranteed <= budget. The base block
  // itself is NOT capped — if it alone exceeds the budget, warn.
  const baseOpen = base ? `<compacted-base kind="${base.kind}" compacted-at="${base.at}">` : "";
  let overhead = SECTION_HEADER.length + 2;
  if (base) overhead += baseOpen.length + 1 + BASE_CLOSE.length + 2 + base.summary.length;
  overhead += allSpans.reduce(
    (a, s, i) => a + spanOpen(i + 1, s.at, s.reason, coversOf(s)).length + SPAN_TRIMMED_ATTR.length + 2 + SPAN_TRIMMED_NOTE.length + 1 + SPAN_CLOSE.length + 2,
    0,
  );
  // Closing line: where the verbatim (uncompacted) tail begins. Spans end at
  // pi's cut point, which is earlier than the compaction time — the tail is
  // named by the first kept entry's timestamp (no time if it cannot be found).
  const keptEntry = opts.firstKeptEntryId ? opts.branchEntries.find((e) => e.id === opts.firstKeptEntryId) : undefined;
  const keptTime = (keptEntry as { timestamp?: unknown } | undefined)?.timestamp;
  const closingLine =
    typeof keptTime === "string" && keptTime !== ""
      ? `Conversation from ${keptTime} onward continues verbatim below — it was not compacted.`
      : `Conversation continues verbatim below — it was not compacted.`;
  overhead += closingLine.length + 2;
  const lines = allSpans.map((s) => s.lines);
  const lineChars = lines.reduce((total, span) => total + span.reduce((n, line) => n + line.length + 1, 0), 0);
  const maxChars = await opts.chooseCap({ overhead, lineChars });
  if (maxChars === null) return undefined;
  if (maxChars !== undefined && base && base.summary.length > maxChars)
    opts.notify(`verbatim-compact: the base block alone is ${base.summary.length.toLocaleString()} chars (budget ${maxChars.toLocaleString()}); it is kept un-capped`);
  const capped = maxChars === undefined ? lines : capSpans(lines, Math.max(500, maxChars - overhead));

  const blocks: string[] = [];
  if (base) blocks.push(`${baseOpen}\n${base.summary.replace(/\n+$/, "")}\n${BASE_CLOSE}`);
  capped.forEach((lines, i) => {
    const s = allSpans[i];
    const open = spanOpen(i + 1, s.at, s.reason, coversOf(s));
    blocks.push(
      lines.length > 0 ? `${open}\n${lines.join("\n")}\n${SPAN_CLOSE}` : `${open.slice(0, -1)}${SPAN_TRIMMED_ATTR}>\n${SPAN_TRIMMED_NOTE}\n${SPAN_CLOSE}`,
    );
  });

  const compactionCount = opts.branchEntries.filter((e) => e.type === "compaction").length + 1;
  const parts: string[] = [];
  parts.push(`## Verbatim compaction checkpoint (compaction ${compactionCount} on this branch)`);
  if (base?.kind === "model-summary") {
    parts.push(MIXED_CONTEXT_WARNING);
    opts.notify(MIXED_CONTEXT_WARNING);
  }
  parts.push(`- Latest: ${opts.now} (trigger: ${opts.reason}, ~${opts.tokensBefore.toLocaleString()} tokens before compaction)`);
  parts.push("- In the compacted spans, user and assistant prose is kept verbatim, subject to budget trimming; tool calls are kept as one-line signatures (arguments truncated). Assistant thinking and tool outputs are removed. Retained prose is a record of what was said, not verification of its claims.");
  parts.push(
    "- pi keeps the most recent part of the conversation verbatim (its `keepRecentTokens` setting). The spans below cover only what came *before* that; everything after the last span is uncompacted.",
  );
  parts.push("- The full transcript before this point is kept in the session; use `context_lookup` to recover details (including thinking and tool outputs).");
  parts.push("");
  parts.push(REORIENT_BLOCK);
  parts.push("");
  parts.push(SECTION_HEADER);
  parts.push("");
  parts.push(blocks.length > 0 ? blocks.join("\n\n") : "(no user or assistant prose in these spans — use context_lookup)");
  // The file lists describe the compacted spans, so they belong above the
  // verbatim boundary line. That closing line is the LAST line of the
  // checkpoint; everything after it is pi's retained verbatim tail.
  const hasFileLists = opts.readFiles.length > 0 || opts.modifiedFiles.length > 0;
  if (hasFileLists) parts.push("");
  if (opts.readFiles.length > 0)
    parts.push(`<read-files note="read before compaction; contents NOT in context">\n${opts.readFiles.join("\n")}\n</read-files>`);
  if (opts.modifiedFiles.length > 0)
    parts.push(`<modified-files note="modified before compaction; current contents NOT in context">\n${opts.modifiedFiles.join("\n")}\n</modified-files>`);
  parts.push("");
  parts.push(closingLine);

  return parts.join("\n");
}

// ============================================================================
// context_lookup subagent: searches the transcript in its own context
// ============================================================================

interface Transcript {
  /** Logical transcript name for subagent citations; never a filesystem path. */
  name: string;
  file: string;
  /** Rendered raw branch, with physical lines and an authoritative entry index. */
  lines: string[];
  index: TranscriptIndexEntry[];
}

/** Entry/section owning a physical line. Only the renderer index is trusted:
 * ENTRY-like text and rules inside tool output cannot spoof attribution. */
function entryAt(lines: string[], idx: number, index: TranscriptIndexEntry[]): { id: string; header: string; section?: string } | undefined {
  const lineNo = idx + 1;
  let lo = 0;
  let hi = index.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].startLine <= lineNo) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return undefined;
  const e = index[found];
  if (lineNo > e.endLine) return undefined;
  let section: string | undefined;
  for (const s of e.sections ?? []) if (s.startLine <= lineNo) section = s.kind;
  return { id: e.id, header: lines[e.startLine - 1] ?? "", section };
}

function listEntries(transcripts: Transcript[], file?: string): string {
  const targets = file ? transcripts.filter((d) => d.name === file) : transcripts;
  const parts: string[] = [];
  for (const d of targets) {
    const rows = d.index.map((e) => {
      const header = d.lines[e.startLine - 1] ?? "";
      const next = d.lines[e.startLine] ?? "";
      const preview = next.trim() !== "" && !next.startsWith(HR) ? `  ${next.trim().slice(0, 90)}` : "";
      return `${header}${preview}`;
    });
    parts.push(`### ${d.name} (${rows.length} entries)\n${rows.join("\n")}`);
  }
  return parts.join("\n\n") || "(no transcript entries)";
}

function grepTranscript(transcripts: Transcript[], opts: { pattern: string; file?: string; before?: number; after?: number; maxMatches?: number }): string {
  const targets = opts.file ? transcripts.filter((d) => d.name === opts.file) : transcripts;
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, "i");
  } catch {
    re = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const before = Math.max(0, opts.before ?? 2);
  const after = Math.max(0, opts.after ?? 6);
  const maxMatches = Math.max(1, opts.maxMatches ?? 15);

  const out: string[] = [];
  let matches = 0;
  for (const d of targets) {
    const hits: number[] = [];
    for (let i = 0; i < d.lines.length; i++) {
      if (re.test(d.lines[i])) {
        hits.push(i);
        if (hits.length >= maxMatches) break;
      }
    }
    if (hits.length === 0) continue;
    for (const i of hits) {
      matches++;
      const entry = entryAt(d.lines, i, d.index);
      out.push(`--- ${d.name} line ${i + 1}${entry ? `  << ${entry.header}${entry.section ? `  [${entry.section}]` : ""}` : ""}`);
      const from = Math.max(0, i - before);
      const to = Math.min(d.lines.length - 1, i + after);
      out.push(d.lines.slice(from, to + 1).map((l, n) => (n + from === i ? `>> ${l}` : `   ${l}`)).join("\n"));
    }
  }
  if (matches === 0) return `No matches for /${opts.pattern}/ in ${targets.map((t) => t.name).join(", ") || "(no transcripts)"}.`;
  return truncateMiddle(out.join("\n\n"), cfg.grepMaxChars);
}

function showEntry(transcripts: Transcript[], opts: { id: string; file?: string; maxLines?: number }): string {
  const targets = opts.file ? transcripts.filter((d) => d.name === opts.file) : transcripts;
  const maxLines = Math.max(10, opts.maxLines ?? 400);
  const out: string[] = [];
  for (const d of targets) {
    const e = d.index.find((x) => x.id === opts.id);
    if (!e) continue;
    const block = d.lines.slice(e.startLine - 2, e.endLine); // includes the rule before the header
    const shown = block.slice(0, maxLines);
    out.push(`### ${d.name}\n${shown.join("\n")}${block.length > maxLines ? `\n…[+${block.length - maxLines} more lines — grep with more context or re-call]` : ""}`);
  }
  return out.length > 0 ? truncateMiddle(out.join("\n\n"), cfg.showEntryMaxChars) : `No entry with id "${opts.id}" found.`;
}

const LOOKUP_WRITEUP_PROMPT =
  "You are out of search turns. Report what you found so far: the facts you confirmed (with ENTRY ids), " +
  "what you couldn't find, and where you'd look next.";

const LOOKUP_SYSTEM_PROMPT = `You are a context-lookup subagent for a coding agent whose main context was compacted by verbatim compaction. The full pre-compaction transcript — including assistant thinking blocks and complete tool outputs that were REMOVED from the main context — is in the transcript files named in the request.

You have three tools:
- list_entries: overview of every entry (id, role, timestamp, preview)
- grep: search the transcript; matches come with surrounding lines and the ENTRY header they belong to
- show_entry: print one full entry block by entry id

Work efficiently: start with list_entries if you don't know where to look, then grep for concrete terms, then show_entry for exact content. When you are confident you have what is needed, stop calling tools and output your final answer as plain text.

Final answer rules (your final message is the ONLY text the main agent sees):
- Return only the important findings. Do not narrate your search process.
- Quote exact error messages, paths, values, and code verbatim where they matter.
- Cite the ENTRY id (and file) for each finding so the main agent can verify.
- If the transcript does not contain the answer, say exactly what is missing.

Provenance rules — label each finding with its source type:
- "user instruction" — what the user asked, pasted, or confirmed
- "observed tool output" — what a tool actually returned at the time (ground truth)
- "reasoning at the time (thinking)" — what the agent believed or hypothesized then; NOT verified fact
Grep attributions include a section tag like [thinking] / [text] / [toolCall]. When a finding rests on old thinking, say explicitly that it was reasoning-at-the-time, so the main agent does not treat it as established fact.`;

async function runLookupSubagent(opts: {
  question: string;
  transcripts: Transcript[];
  model: Model;
  registry: ModelRegistry;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const toc = truncateMiddle(listEntries(opts.transcripts).split("\n").slice(0, 60).join("\n"), 4_000);

  const tools: AiTool[] = [
    {
      name: "list_entries",
      description: "List every ENTRY header in the transcript (id, role, timestamp, first-line preview). Optional `file` restricts to a transcript name.",
      parameters: Type.Object({
        file: Type.Optional(Type.String({ description: "Transcript name (see transcript file list). Omit for all." })),
      }),
    },
    {
      name: "grep",
      description: "Regex-search the transcript lines. Returns matching lines with surrounding context and entry attribution. `pattern` is a JS regex (case-insensitive).",
      parameters: Type.Object({
        pattern: Type.String({ description: "JS regex, case-insensitive" }),
        file: Type.Optional(Type.String({ description: "Transcript name. Omit for all." })),
        before: Type.Optional(Type.Number({ description: "Context lines before (default 2)" })),
        after: Type.Optional(Type.Number({ description: "Context lines after (default 6)" })),
        maxMatches: Type.Optional(Type.Number({ description: "Max matches per file (default 15)" })),
      }),
    },
    {
      name: "show_entry",
      description: "Print one full entry block by its ENTRY id (from list_entries or grep attribution).",
      parameters: Type.Object({
        id: Type.String({ description: "Entry id" }),
        file: Type.Optional(Type.String({ description: "Transcript name. Omit for all." })),
        maxLines: Type.Optional(Type.Number({ description: "Max lines to return (default 400)" })),
      }),
    },
  ];

  const messages: AiMessage[] = [
    {
      role: "user",
      content:
        `Question: ${opts.question}\n\n` +
        `Transcript files (full raw session branch; ENTRY blocks are anchored by entry id):\n` +
        opts.transcripts.map((d) => `- ${d.file}`).join("\n") +
        `\n\nTranscript overview (first entries; call list_entries for the full list):\n${toc}`,
      timestamp: Date.now(),
    },
  ];

  const dispatch = (name: string, args: Record<string, any>): string => {
    try {
      switch (name) {
        case "list_entries":
          return listEntries(opts.transcripts, args.file);
        case "grep":
          return grepTranscript(opts.transcripts, args);
        case "show_entry":
          return showEntry(opts.transcripts, args);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool error: ${errMsg(err)}`;
    }
  };

  const sessionId = uuidv7();
  let lastText = "";
  for (let turn = 0; turn < cfg.lookupTurns; turn++) {
    const resp = await opts.registry.complete(
      opts.model,
      normalizeContext({ systemPrompt: LOOKUP_SYSTEM_PROMPT, messages, tools }),
      { signal: opts.signal, cacheRetention: "none", sessionId, maxTokens: 4096 },
    );
    if (resp.stopReason === "aborted") return "(lookup subagent aborted)";
    if (resp.stopReason === "error") return `(lookup subagent error: ${resp.errorMessage ?? "unknown"})`;

    const toolCalls = resp.content.filter((b) => b.type === "toolCall");
    const text = contentText(resp.content);
    if (text) lastText = text;

    if (toolCalls.length === 0) {
      return truncateMiddle(text || "(subagent returned no answer)", cfg.lookupAnswerMaxChars);
    }

    messages.push(resp);
    for (const call of toolCalls) {
      const args = (call.arguments ?? {}) as Record<string, any>;
      const result = dispatch(String(call.name), args);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: String(call.name),
        content: [{ type: "text", text: result }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  // Out of search turns: one extra call with no tools, asking for a write-up of
  // what was found, so a timed-out lookup still returns usable findings.
  messages.push({ role: "user", content: LOOKUP_WRITEUP_PROMPT, timestamp: Date.now() });
  const marker = `[subagent reached the ${cfg.lookupTurns}-turn limit; this is its write-up of partial findings]`;
  let writeupError = "";
  try {
    const resp = await opts.registry.complete(
      opts.model,
      normalizeContext({ systemPrompt: LOOKUP_SYSTEM_PROMPT, messages }),
      { signal: opts.signal, cacheRetention: "none", sessionId, maxTokens: 4096 },
    );
    const text = resp.stopReason === "aborted" || resp.stopReason === "error" ? "" : contentText(resp.content);
    if (text) return truncateMiddle(`${text}\n${marker}`, cfg.lookupAnswerMaxChars);
  } catch (err) {
    writeupError = errMsg(err);
  }
  const why = writeupError ? `; write-up failed: ${writeupError}` : "";
  return truncateMiddle(`${lastText}\n[subagent reached the ${cfg.lookupTurns}-turn limit; findings may be incomplete${why}]`, cfg.lookupAnswerMaxChars);
}

// ============================================================================
// Session-backed transcript (rendered only when context_lookup is called)
// ============================================================================

function sessionTranscript(ctx: { sessionManager: { getBranch: () => SessionEntry[] } }): Transcript {
  const override = process.env.MECH_COMPACT_LOOKUP_SESSION_FILE?.trim();
  let entries: SessionEntry[];
  if (override) {
    // Fail closed: never silently search the pruned fork when an override is
    // misconfigured. Guard open() because pi initializes empty/missing files.
    if (!path.isAbsolute(override)) throw new Error("MECH_COMPACT_LOOKUP_SESSION_FILE must be an absolute path.");
    const stat = fs.statSync(override);
    if (!stat.isFile() || stat.size === 0) throw new Error("MECH_COMPACT_LOOKUP_SESSION_FILE must name a non-empty session JSONL file.");
    entries = SessionManager.open(override).getBranch();
  } else {
    // getBranch() is raw history, unlike buildSessionContext(): compaction
    // and context edits never remove earlier thinking or tool results here.
    entries = ctx.sessionManager.getBranch();
  }
  const { lines, index } = branchToTranscript(entries);
  return { name: "session", file: "session", lines, index };
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Method selection never changes Pi's auto-compaction enabled setting.
  pi.registerCommand("compaction-method", {
    description: "Show or set the session compaction method: verbatim|summary (manual and automatic)",
    getArgumentCompletions: (prefix) => ["verbatim", "summary"]
      .filter((method) => method.startsWith(prefix))
      .map((method) => ({ value: method, label: method })),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested && requested !== "verbatim" && requested !== "summary") {
        ctx.ui.notify("Usage: /compaction-method [verbatim|summary]", "error");
        return;
      }
      const entries = ctx.sessionManager.getBranch();
      const previous = compactionMethod(entries);
      const method = requested || previous;
      const changed = method !== previous;
      if (changed) pi.appendEntry(METHOD_ENTRY, { method });
      ctx.ui.notify(`Compaction method: ${method} (manual, automatic, and overflow recovery).`, "info");
      if (changed && method === "summary") ctx.ui.notify(SUMMARY_COMPACTION_WARNING, "warning");
      else if (changed && collectBaseAndSpans(entries).base?.kind === "model-summary") ctx.ui.notify(MIXED_CONTEXT_WARNING, "warning");
    },
  });

  pi.registerCommand("cap-compaction", {
    description: "Show or set verbatim compaction cap: on|off|warn [80000c|20000t|25%]",
    getArgumentCompletions: (prefix) => {
      const mode = /^(on|off|warn)\s/.exec(prefix)?.[1];
      const values = mode ? ["80000c", "20000t", "25%"].map((budget) => `${mode} ${budget}`)
        : ["on", "off", "warn", "80000c", "20000t", "25%"];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const previous = capSettings(ctx.sessionManager.getBranch());
      const words = args.trim().split(/\s+/).filter(Boolean);
      const mode = ["on", "off", "warn"].includes(words[0]) ? words.shift() as CapMode : previous.mode;
      const budget = words.length === 0 ? previous.budget : words.length === 1 ? parseCapBudget(words[0]) : undefined;
      if (!budget) {
        ctx.ui.notify("Usage: /cap-compaction [on|off|warn] [<chars>c|<estimated tokens>t|<percent>%]; percentages must be >0 and <=100.", "error");
        return;
      }
      const next = { mode, budget };
      persistCap(pi, previous, next);
      ctx.ui.notify(`${capDescription(next, ctx.model?.contextWindow)} Applies only to verbatim compaction.`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    if (compactionMethod(entries) === "verbatim" && collectBaseAndSpans(entries).base?.kind === "model-summary") {
      ctx.ui.notify(MIXED_CONTEXT_WARNING, "warning");
    }

    // Amend the built-in command's autocomplete description, not its handler.
    // Older Pi versions without this API keep their original description.
    if (ctx.mode !== "tui" || typeof ctx.ui.addAutocompleteProvider !== "function") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      get triggerCharacters() { return current.triggerCharacters; },
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!suggestions || !/^\/\S*$/.test(suggestions.prefix)) return suggestions;
        const method = compactionMethod(ctx.sessionManager.getBranch());
        return {
          ...suggestions,
          items: suggestions.items.map((item) => item.value === "compact"
            ? { ...item, description: method === "verbatim"
              ? "Manually compact with verbatim-compact"
              : "Manually compact with summary compaction" }
            : item),
        };
      },
      applyCompletion: (...args) => current.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? true,
    }));
  });

  // --------------------------------------------------------------------------
  // Mechanical compaction
  // --------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, reason, signal } = event;
    if (!preparation) return;
    if (signal?.aborted) return;
    if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0) return;
    if (compactionMethod(ctx.sessionManager.getBranch()) === "summary") {
      return; // No override: Pi runs its normal model-generated compaction.
    }

    // No disk snapshot: pi retains the full raw branch in its session.

    // 1) Cumulative file lists: pi only carries lists from pi-generated
    //    compactions (fromHook=false), so we carry our own forward.
    try {
      const fileOps = preparation.fileOps as { read: Set<string>; written: Set<string>; edited: Set<string> } | undefined;
      if (fileOps) {
        for (let i = branchEntries.length - 1; i >= 0; i--) {
          const e = branchEntries[i];
          if (e.type === "compaction") {
            const d = (e as { details?: { kind?: string; readFiles?: string[]; modifiedFiles?: string[] } }).details;
            if (d?.kind === MECH_KIND) {
              for (const f of d.readFiles ?? []) fileOps.read.add(f);
              for (const f of d.modifiedFiles ?? []) fileOps.edited.add(f);
              break;
            }
          }
        }
      }

      const modified = new Set([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])]);
      const modifiedFiles = [...modified].sort();
      const readFiles = [...(fileOps?.read ?? [])].filter((f) => !modified.has(f)).sort();

      // 2) The new span. Pi's preparation span is [previous cut, current cut)
      //    — it includes the previous compaction's retained tail (verified
      //    against prepareCompaction: the projection places the retained tail
      //    right after the previous compaction entry and boundaryStart sits at
      //    it), so consecutive spans tile: nothing is summarized twice or
      //    missed. No entry-id bookkeeping is needed; the next preparation is
      //    authoritative.
      const nowIso = new Date().toISOString();
      const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      // Span coverage range: first/last summarised message timestamps (pi
      // message timestamps are epoch ms; ISO strings are accepted too).
      const toIso = (ts: unknown): string | undefined => {
        const t = typeof ts === "number" ? ts : typeof ts === "string" && ts !== "" ? Date.parse(ts) : NaN;
        return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
      };
      const msgTs = (m: AgentMessage): unknown => (m as unknown as { timestamp?: unknown }).timestamp;
      const spanFrom = toIso(msgTs(allMessages[0]));
      const spanTo = toIso(msgTs(allMessages[allMessages.length - 1]));
      const spanLines = summarizeMessages(allMessages);

      // 3) Build the mechanical summary (no LLM call).
      const summary = await buildMechanicalSummary({
        reason, // pi's raw reason, passed through unchanged
        tokensBefore: preparation.tokensBefore,
        branchEntries,
        now: nowIso,
        spanLines,
        spanFrom,
        spanTo,
        firstKeptEntryId: preparation.firstKeptEntryId,
        readFiles,
        modifiedFiles,
        notify: (m) => ctx.ui?.notify?.(m, "warning"),
        chooseCap: (size) => chooseCapBudget(pi, ctx, signal, reason, size),
      });
      if (summary === undefined || signal?.aborted) return { cancel: true };

      ctx.ui?.notify?.(
        `verbatim-compact: ~${preparation.tokensBefore.toLocaleString()} tokens -> verbatim checkpoint; full transcript kept in the session`,
        "info",
      );

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            kind: MECH_KIND,
            readFiles,
            modifiedFiles,
            // Only this compaction's own span (un-capped lines). Earlier spans
            // are re-rendered from the earlier entries' details — no nesting.
            span: { at: nowIso, from: spanFrom, to: spanTo, reason, tokensBefore: preparation.tokensBefore, lines: spanLines },
          },
        },
      };
    } catch (err) {
      ctx.ui?.notify?.(`verbatim-compact: failed to build checkpoint (${errMsg(err)}); falling back to Pi's summary compaction`, "error");
      return;
    }
  });

  // --------------------------------------------------------------------------
  // context_lookup tool: subagent research over the raw session branch
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "context_lookup",
    label: "Context lookup",
    description:
      "Recover information preserved in the session but removed from your active context by verbatim compaction—including thinking, tool outputs, error text, file contents, and earlier decisions. Spawns a subagent that searches the full raw session branch (across all compactions) in its OWN context and returns only relevant findings. Does not search abandoned branches or other sessions. Do NOT grep the session file yourself in the main conversation.",
    promptSnippet: "Ask a subagent to research dropped context in the session transcript",
    parameters: Type.Object({
      question: Type.String({ description: "What to find in the dropped context. Be specific (exact error text, file, decision, command output…)." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let model: Model | undefined;
      if (cfg.lookupModel) {
        const slash = cfg.lookupModel.indexOf("/");
        if (slash > 0) model = ctx.modelRegistry.find(cfg.lookupModel.slice(0, slash), cfg.lookupModel.slice(slash + 1));
      }
      model = model ?? ctx.model;
      if (!model) {
        return { content: [{ type: "text", text: "context_lookup needs a model (session model or MECH_COMPACT_LOOKUP_MODEL)." }], details: undefined };
      }

      try {
        if (signal?.aborted) return { content: [{ type: "text", text: "(lookup subagent aborted)" }], details: undefined };
        const transcript = sessionTranscript(ctx);
        if (transcript.index.length === 0)
          return { content: [{ type: "text", text: "No entries found on the session branch." }], details: undefined };
        const answer = await runLookupSubagent({ question: params.question, transcripts: [transcript], model, registry: ctx.modelRegistry, signal });
        return { content: [{ type: "text", text: answer }], details: undefined };
      } catch (err) {
        return { content: [{ type: "text", text: `context_lookup failed: ${errMsg(err)}` }], details: undefined };
      }
    },
  });
}
