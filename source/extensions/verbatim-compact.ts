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
 *   MECH_COMPACT_LOOKUP_MAX_CALLS     consecutive lookup limit (default 1;
 *                                    0 = unlimited). Non-recovery tool results,
 *                                    bash executions, or user messages reset it.
 *                                    Fallback tools neither count nor reset it.
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

function lookupMaxCallsFromEnv(): number {
  const raw = process.env.MECH_COMPACT_LOOKUP_MAX_CALLS?.trim();
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : 1;
}

const cfg = {
  defaultCapBudget: (process.env.MECH_COMPACT_MAX_SUMMARY_CHARS
    ? { unit: "chars", value: intFromEnv("MECH_COMPACT_MAX_SUMMARY_CHARS", 80_000) }
    : { unit: "percent", value: percentFromEnv("MECH_COMPACT_MAX_SUMMARY_PERCENT", 25) }) as CapBudget,
  lookupTurns: intFromEnv("MECH_COMPACT_LOOKUP_TURNS", 10),
  lookupMaxCalls: lookupMaxCallsFromEnv(),
  lookupModel: process.env.MECH_COMPACT_LOOKUP_MODEL?.trim() || undefined,
  argSnippetChars: 160,
  listMaxChars: 12_000,
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
    : `${(chars / 4).toLocaleString()} estimated tokens at 4 chars/token; ${chars.toLocaleString()} chars`;
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

function truncateHead(text: string, max: number): string {
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

**Recovering dropped details.** Information removed from your active context is preserved in the session, including earlier thinking and tool outputs. Prefer \`context_lookup\` with a specific question: a subagent searches the transcript in its own context and returns relevant findings. If its findings are incomplete, use the bounded fallback tools \`context_list_entries\`, \`context_grep\`, and \`context_show_entry\`; follow their pagination instructions for more detail. Do not read or grep raw session JSONL files or old dumps through filesystem tools in this conversation — use these recovery tools instead.`;

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

// Keep page boundaries between Unicode characters, never inside a surrogate pair.
function characterBoundary(text: string, start: number, end: number): number {
  const prev = text.charCodeAt(end - 1), next = text.charCodeAt(end);
  return end > start && prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

// An entry-id boundary pins a paginated listing/search while new tool calls
// and results append to the branch. It is not a snapshot or a filesystem path.
function transcriptWindow(transcripts: Transcript[], file?: string, throughEntry?: string): Transcript[] {
  const targets = file ? transcripts.filter((d) => d.name === file) : transcripts;
  if (!throughEntry) return targets;
  const bounded: Transcript[] = [];
  for (const d of targets) {
    const at = d.index.findIndex((e) => e.id === throughEntry);
    if (at >= 0) bounded.push({ ...d, lines: d.lines.slice(0, d.index[at].endLine), index: d.index.slice(0, at + 1) });
  }
  if (!bounded.length) throw new Error(`Pagination boundary ENTRY "${throughEntry}" is not on this transcript branch. Restart at offset=0 without throughEntry.`);
  return bounded;
}

// Offsets count JavaScript string characters (UTF-16 code units), not tokens.
// Pagination never discards a suffix: even a single enormous physical line is
// accessible. Only response payloads are capped; small status/cursor notes are extra.
function pageText(text: string, opts: { offset?: number; maxChars: number; maxLines?: number; attribution: string; continuation?: string }): string {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  if (offset >= text.length) return `No more content at offset=${offset} (${text.length} total characters).`;
  let end = Math.min(text.length, offset + opts.maxChars);
  if (opts.maxLines !== undefined) {
    let lines = 0;
    for (let i = offset; i < end; i++) {
      if (text[i] === "\n" && ++lines >= opts.maxLines) { end = i + 1; break; }
    }
  }
  end = characterBoundary(text, offset, end);
  const prefix = offset > 0 ? `[Continuation: ${truncateHead(opts.attribution, 1_000)}; offset=${offset}]\n` : "";
  const body = text.slice(offset, end);
  const notice = end < text.length
    ? `\n[Page limited: characters ${offset}–${end - 1} of ${text.length}; ${text.length - end} characters remain. Continue with the same parameters and offset=${end}${opts.continuation ?? ""}.]`
    : "";
  return prefix + body + notice;
}

function listEntries(transcripts: Transcript[], opts: { file?: string; offset?: number; throughEntry?: string } = {}): string {
  const targets = transcriptWindow(transcripts, opts.file, opts.throughEntry);
  const throughEntry = targets.length === 1 ? targets[0].index.at(-1)?.id : undefined;
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
  return parts.length ? pageText(parts.join("\n\n"), {
    offset: opts.offset, maxChars: cfg.listMaxChars, attribution: `entry listing for ${targets.map((t) => t.name).join(", ")}`,
    continuation: throughEntry ? `, throughEntry=${JSON.stringify(throughEntry)}` : "",
  }) : "(no transcript entries)";
}

interface GrepOptions { pattern: string; file?: string; before?: number; after?: number; maxMatches?: number; offset?: number; charOffset?: number; throughEntry?: string }
function grepTranscript(transcripts: Transcript[], opts: GrepOptions): string {
  const targets = transcriptWindow(transcripts, opts.file, opts.throughEntry);
  const throughEntry = targets.length === 1 ? targets[0].index.at(-1)?.id : undefined;
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, "i");
  } catch {
    re = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const before = Math.max(0, Math.floor(opts.before ?? 2));
  const after = Math.max(0, Math.floor(opts.after ?? 6));
  const maxMatches = Math.max(1, Math.floor(opts.maxMatches ?? 15));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  let charOffset = Math.max(0, Math.floor(opts.charOffset ?? 0));
  const hits: { transcript: Transcript; line: number }[] = [];
  for (const d of targets) {
    for (let i = 0; i < d.lines.length; i++) if (re.test(d.lines[i])) hits.push({ transcript: d, line: i });
  }
  if (hits.length === 0) return `No matches for /${opts.pattern}/ in ${targets.map((t) => t.name).join(", ") || "(no transcripts)"}.`;
  if (offset >= hits.length) return `No more matches at offset=${offset} (${hits.length} total matches).`;

  const out: string[] = [];
  let size = 0;
  let next = offset;
  for (; next < hits.length && next < offset + maxMatches; next++) {
    const { transcript: d, line: i } = hits[next];
    const entry = entryAt(d.lines, i, d.index);
    const header = truncateHead(`--- ${d.name} line ${i + 1}${entry ? `  << ${entry.header}${entry.section ? `  [${entry.section}]` : ""}` : ""}`, 1_000);
    const from = Math.max(0, i - before);
    const to = Math.min(d.lines.length - 1, i + after);
    const body = d.lines.slice(from, to + 1).map((l, n) => (n + from === i ? `>> ${l}` : `   ${l}`)).join("\n");
    if (charOffset >= body.length) return `Invalid charOffset=${charOffset} for match offset=${next} (${body.length} characters).`;
    const prefix = `${header}${charOffset ? `  [match offset=${next}, charOffset=${charOffset}]` : ""}\n`;
    const available = cfg.grepMaxChars - size - prefix.length - (out.length ? 2 : 0);
    if (available <= 0) break;
    const end = characterBoundary(body, charOffset, Math.min(body.length, charOffset + available));
    if (end === charOffset) break;
    const chunk = prefix + body.slice(charOffset, end);
    out.push(chunk);
    size += chunk.length + (out.length > 1 ? 2 : 0);
    if (end < body.length) { charOffset = end; break; }
    charOffset = 0;
  }
  const notice = next < hits.length
    ? `\n[Page limited: ${hits.length} total matches; ${hits.length - next} matches remain${charOffset ? " (including the partially shown match)" : ""}. Continue with the same parameters and offset=${next}, charOffset=${charOffset}${throughEntry ? `, throughEntry=${JSON.stringify(throughEntry)}` : ""}.]`
    : "";
  return out.join("\n\n") + notice;
}

function showEntry(transcripts: Transcript[], opts: { id: string; file?: string; maxLines?: number; offset?: number }): string {
  const targets = opts.file ? transcripts.filter((d) => d.name === opts.file) : transcripts;
  const out: string[] = [];
  const headers: string[] = [];
  for (const d of targets) {
    const e = d.index.find((x) => x.id === opts.id);
    if (!e) continue;
    const block = d.lines.slice(e.startLine - 2, e.endLine); // includes the rule before the header
    out.push(`### ${d.name}\n${block.join("\n")}`);
    headers.push(`${d.name}: ${d.lines[e.startLine - 1]}`);
  }
  return out.length ? pageText(out.join("\n\n"), {
    offset: opts.offset, maxChars: cfg.showEntryMaxChars,
    maxLines: Math.max(1, Math.floor(opts.maxLines ?? 400)), attribution: headers.join("; "),
  }) : `No entry with id "${opts.id}" found.`;
}

// Identical paging parameters in the subagent and direct tools; only the
// subagent accepts a logical transcript name (not a filesystem path).
const OFFSET_FIELD = Type.Optional(Type.Integer({ minimum: 0, description: "Character offset (UTF-16 units, default 0). Use the next offset reported by the previous page." }));
const FILE_FIELD = Type.Optional(Type.String({ description: "Logical transcript name. Omit for all." }));
const THROUGH_ENTRY_FIELD = Type.Optional(Type.String({ description: "Last ENTRY id included in this paginated listing/search. Keep the reported throughEntry on subsequent pages to exclude newly appended calls/results; omit to start a fresh search." }));
const LIST_FIELDS = { offset: OFFSET_FIELD, throughEntry: THROUGH_ENTRY_FIELD };
const GREP_FIELDS = {
  pattern: Type.String({ description: "JS regex, case-insensitive" }),
  before: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines before (default 2)" })),
  after: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines after (default 6)" })),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1, description: "Max matches per page (default 15); character limit also applies" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Match offset (0-based, default 0). Use the next offset reported by the previous page." })),
  charOffset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset within that match's context (default 0). Use with offset to continue a partially shown match." })),
  throughEntry: THROUGH_ENTRY_FIELD,
};
const SHOW_FIELDS = {
  id: Type.String({ description: "Entry id" }),
  maxLines: Type.Optional(Type.Integer({ minimum: 1, description: "Max lines per page (default 400); character limit also applies" })),
  offset: OFFSET_FIELD,
};

const LOOKUP_FALLBACK_NOTE =
  "If more detail is needed for this query, use context_list_entries, context_grep, or context_show_entry rather than immediately repeating context_lookup.";

// Append outside the truncated findings so the next-step guidance survives
// even a long write-up. Normal successful answers remain unchanged.
function lookupPartialFindings(text: string, marker: string): string {
  const status = truncateHead(marker, 1_000); // Provider error messages can be large too.
  const budget = cfg.lookupAnswerMaxChars - status.length - LOOKUP_FALLBACK_NOTE.length - 2;
  return `${truncateHead(text, budget)}\n${status}\n${LOOKUP_FALLBACK_NOTE}`;
}

const LOOKUP_WRITEUP_PROMPT =
  "You are out of search turns. Report what you found so far: the facts you confirmed (with ENTRY ids), " +
  "what you couldn't find, and where you'd look next.";

const LOOKUP_SYSTEM_PROMPT = `You are a context-lookup subagent for a coding agent whose main context was compacted by verbatim compaction. The full pre-compaction transcript — including assistant thinking blocks and complete tool outputs that were REMOVED from the main context — is in the transcript files named in the request.

You have three tools:
- list_entries: paginated overview of entries (id, role, timestamp, preview)
- grep: paginated transcript search; matches come with surrounding lines and authoritative ENTRY attribution
- show_entry: retrieve an entry by id in bounded pages

Search tools bound each response, not the underlying history. If a page is limited, follow its continuation parameters to retrieve later matches or the rest of an entry, including oversized single lines. A partial page is not the entire evidence.

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
  const toc = truncateHead(listEntries(opts.transcripts).split("\n").slice(0, 60).join("\n"), 4_000);

  const tools: AiTool[] = [
    {
      name: "list_entries",
      description: "List ENTRY headers and previews in pages of up to 12000 payload characters, plus cursor notes. Follow all reported continuation parameters (offset and throughEntry). Optional file restricts to a logical transcript name.",
      parameters: Type.Object({ ...LIST_FIELDS, file: FILE_FIELD }),
    },
    {
      name: "grep",
      description: "Regex-search transcript lines with surrounding context and authoritative entry attribution. Up to 12000 payload characters per page, plus cursor notes. Follow all reported continuation parameters (offset, charOffset, throughEntry) for remaining matches or oversized lines. pattern is a JS regex (case-insensitive).",
      parameters: Type.Object({ ...GREP_FIELDS, file: FILE_FIELD }),
    },
    {
      name: "show_entry",
      description: "Retrieve an indexed entry by ENTRY id in pages of up to 24000 payload characters and maxLines lines, plus attribution/cursor notes. Follow the reported offset for the rest; a page may not contain the entire entry.",
      parameters: Type.Object({ ...SHOW_FIELDS, file: FILE_FIELD }),
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
          return listEntries(opts.transcripts, args);
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
      { signal: opts.signal, sessionId, maxTokens: 4096 },
    );
    if (resp.stopReason === "aborted") return "(lookup subagent aborted)";
    if (resp.stopReason === "error") return `(lookup subagent error: ${resp.errorMessage ?? "unknown"})`;

    const toolCalls = resp.content.filter((b) => b.type === "toolCall");
    const text = contentText(resp.content);
    if (text) lastText = text;

    if (toolCalls.length === 0) {
      return truncateHead(text || "(subagent returned no answer)", cfg.lookupAnswerMaxChars);
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
      { signal: opts.signal, sessionId, maxTokens: 4096 },
    );
    const text = resp.stopReason === "aborted" || resp.stopReason === "error" ? "" : contentText(resp.content);
    if (text) return lookupPartialFindings(text, marker);
  } catch (err) {
    writeupError = errMsg(err);
  }
  const why = writeupError ? `; write-up failed: ${writeupError}` : "";
  return lookupPartialFindings(lastText, `[subagent reached the ${cfg.lookupTurns}-turn limit; findings may be incomplete${why}]`);
}

// ============================================================================
// Session-backed transcript (rendered only when a recovery tool is called)
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
// Main-agent fallback: the same transcript search functions as the subagent
// ============================================================================

const FALLBACK_TOOL_NAMES = new Set(["context_list_entries", "context_grep", "context_show_entry"]);

/** Count prior lookup attempts since the last user/ordinary-work/bash boundary.
 * Fallback results, text, and thinking neither increase nor reset the count. Deduplicate call/result ids, and include
 * earlier siblings in the current assistant message even before results exist:
 * two parallel lookups cannot both claim the first slot. Later siblings are
 * excluded. Raw branch state follows reload, resume, compaction, and forks. */
function consecutiveLookups(ctx: { sessionManager: { getBranch: () => SessionEntry[] } }, toolCallId: string): number {
  const entries = ctx.sessionManager.getBranch();
  const calls = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message") continue;
    const m = e.message;
    if (m.role === "user" || m.role === "bashExecution") break;
    if (m.role === "toolResult") {
      if (FALLBACK_TOOL_NAMES.has(m.toolName)) continue;
      if (m.toolName !== "context_lookup") break;
      calls.add(m.toolCallId);
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type !== "toolCall") continue;
        if (b.id === toolCallId) break;
        if (b.name === "context_lookup") calls.add(b.id);
      }
    }
  }
  return calls.size;
}

function registerDirectTools(pi: ExtensionAPI): void {
  const pre = "Fallback after context_lookup, when its findings are incomplete: ";
  const run = (ctx: { sessionManager: { getBranch: () => SessionEntry[] } }, f: (t: Transcript[]) => string) => {
    try {
      const transcript = sessionTranscript(ctx);
      if (transcript.index.length === 0) return { content: [{ type: "text" as const, text: "No entries found on the session branch." }], details: undefined };
      return { content: [{ type: "text" as const, text: f([transcript]) }], details: undefined };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Tool error: ${errMsg(err)}` }], details: undefined };
    }
  };
  pi.registerTool({
    name: "context_list_entries",
    label: "Context: list entries",
    description: pre + "List raw session ENTRY headers and previews, including compacted entries, in pages of up to 12000 payload characters, plus cursor notes. Follow all reported continuation parameters (offset and throughEntry).",
    promptSnippet: "Fallback: list session entries when subagent findings are incomplete",
    parameters: Type.Object(LIST_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => listEntries(t, params));
    },
  });
  pi.registerTool({
    name: "context_grep",
    label: "Context: grep",
    description: pre + "Regex-search the full raw session branch, including compacted thinking and tool outputs, with surrounding lines and authoritative entry attribution. pattern is a JS regex (case-insensitive). Up to 12000 payload characters per page, plus cursor notes. Follow all reported continuation parameters (offset, charOffset, throughEntry) for remaining matches or oversized lines. Historical thinking is not verified fact.",
    promptSnippet: "Fallback: search session evidence when subagent findings are incomplete",
    parameters: Type.Object(GREP_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => grepTranscript(t, params));
    },
  });
  pi.registerTool({
    name: "context_show_entry",
    label: "Context: show entry",
    description: pre + "Retrieve an indexed session entry by ENTRY id (from context_list_entries or context_grep) in pages of up to 24000 payload characters and maxLines lines, plus attribution/cursor notes. Follow the reported offset for the rest; a page may not contain the entire entry.",
    promptSnippet: "Fallback: retrieve session entry pages when subagent findings are incomplete",
    parameters: Type.Object(SHOW_FIELDS),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return run(ctx, (t) => showEntry(t, params));
    },
  });
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
  registerDirectTools(pi);
  pi.registerTool({
    name: "context_lookup",
    label: "Context lookup",
    executionMode: "sequential",
    description:
      "Recover information preserved in the session but removed from your active context by verbatim compaction—including thinking, tool outputs, error text, file contents, and earlier decisions. Spawns a subagent that searches the full raw session branch (across all compactions) in its OWN context and returns only relevant findings. Does not search abandoned branches or other sessions. Prefer this tool first; if findings are incomplete, use the bounded context_list_entries, context_grep, and context_show_entry fallback tools. Follow their pagination instructions. Do not read or grep raw session JSONL files or old dumps through filesystem tools. Repeated lookup calls without a non-recovery tool result, user message, or bash execution are limited. The three fallback tools neither increase nor reset the lookup count; narration and thinking do not reset it either.",
    promptSnippet: "Ask a subagent to research dropped context in the session transcript",
    parameters: Type.Object({
      question: Type.String({ description: "What to find in the dropped context. Be specific (exact error text, file, decision, command output…)." }),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (cfg.lookupMaxCalls > 0 && consecutiveLookups(ctx, toolCallId) >= cfg.lookupMaxCalls) {
        return {
          content: [{ type: "text", text: `context_lookup consecutive-call limit reached (${cfg.lookupMaxCalls}). ${LOOKUP_FALLBACK_NOTE}` }],
          details: undefined,
        };
      }
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
