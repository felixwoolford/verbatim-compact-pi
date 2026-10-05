/**
* verbatim-compact — deterministic, verbatim-preserving compaction for pi.
*
* Replaces pi's model-generated compaction summary with a checkpoint built
* mechanically from the dropped messages (thinking and tool outputs removed),
* after dumping the full branch to .pi/context-dumps/. Dropped details are
* recovered via the context_lookup subagent.
*
* Dumps are scoped to the session by entry-id overlap: a dump belongs to the
* current session when its meta.json index contains the current branch's
* first entry id (pre-index dumps fall back to the meta.json sessionFile).
* After each dump write, older dumps of this session that are provably
* contained in the new one (every indexed entry id present in it) are pruned.
*
* See README.md for the checkpoint format, install, settings and design notes.
*
* Optional env settings:
*   MECH_COMPACT_MAX_SUMMARY_CHARS  size guard for the checkpoint (default 80000)
*   MECH_COMPACT_LOOKUP_MODEL       "provider/modelId" for the lookup subagent
*   MECH_COMPACT_LOOKUP_TURNS       max search turns (default 10), plus one final
*                                  write-up call if the search budget is exhausted
*   MECH_COMPACT_DUMP_DIR           absolute path that replaces <project>/.pi/context-dumps
*                                  (relative values are ignored with a warning)
*   MECH_COMPACT_WARN_GITIGNORE     warn when dumps land in a git repo that doesn't
*                                  ignore them (default on; 0/false/no/off disables)
*/

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import { contentText, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import type { Message as AiMessage, Model, Tool as AiTool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Configuration
// ============================================================================

const MECH_KIND = "mech-compact";
const DUMP_ROOT_PARTS = [".pi", "context-dumps"] as const;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return fallback;
}

const cfg = {
  maxSummaryChars: intFromEnv("MECH_COMPACT_MAX_SUMMARY_CHARS", 80_000),
  lookupTurns: intFromEnv("MECH_COMPACT_LOOKUP_TURNS", 10),
  lookupModel: process.env.MECH_COMPACT_LOOKUP_MODEL?.trim() || undefined,
  argSnippetChars: 160,
  grepMaxChars: 12_000,
  showEntryMaxChars: 24_000,
  lookupAnswerMaxChars: 12_000,
  warnGitIgnore: boolFromEnv("MECH_COMPACT_WARN_GITIGNORE", true),
};

// Optional absolute-path override for the dump root (MECH_COMPACT_DUMP_DIR).
// Relative values are rejected: they would resolve against the wrong base
// depending on which process cwd reads them.
const dumpDirOverrideRaw = process.env.MECH_COMPACT_DUMP_DIR?.trim() || undefined;
const dumpDirOverride = dumpDirOverrideRaw && path.isAbsolute(dumpDirOverrideRaw) ? dumpDirOverrideRaw : undefined;
if (dumpDirOverrideRaw && !dumpDirOverride)
  console.warn(
    `verbatim-compact: MECH_COMPACT_DUMP_DIR must be an absolute path; ignoring "${dumpDirOverrideRaw}" and using <project>/.pi/context-dumps`,
  );

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
    if (images > 0) text += `\n[${images} image(s) attached — binary, not inlined in dumps]`;
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
// Dump: full-fidelity branch serialization (untruncated, entry-anchored)
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

interface DumpIndexSection {
  kind: string;
  /** 1-based line number of the section marker line */
  startLine: number;
}

interface DumpIndexEntry {
  id: string;
  type: string;
  role?: string;
  /** 1-based line number of the ENTRY header line */
  startLine: number;
  /** 1-based line number of the last line of the block (inclusive) */
  endLine: number;
  sections?: DumpIndexSection[];
}

function branchToDump(entries: SessionEntry[]): { lines: string[]; index: DumpIndexEntry[] } {
  const lines: string[] = [
    "# pi context dump — full pre-compaction branch",
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
  const index: DumpIndexEntry[] = blocks.map((b, i) => {
    const e: DumpIndexEntry = {
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

interface DumpInfo {
  dir: string;
  conversationPath: string;
  metaPath: string;
  chars: number;
}

function writeDump(opts: {
  entries: SessionEntry[];
  cwd: string;
  sessionFile: string | null;
  reason: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
}): DumpInfo {
  const now = new Date();
  const stamp = now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  // 8 chars of real randomness (the timestamp in `stamp` already orders dumps;
  // the suffix exists so two dumps in the same second never overwrite each other)
  const suffix = Math.random().toString(36).slice(2, 10);
  const dir = path.join(dumpRoot(opts.cwd), `${stamp}_${suffix}`);
  fs.mkdirSync(dir, { recursive: true });

  const { lines, index } = branchToDump(opts.entries);
  const conversation = lines.join("\n");
  const meta = {
    kind: "pi-context-dump",
    timestamp: now.toISOString(),
    reason: opts.reason,
    cwd: opts.cwd,
    sessionFile: opts.sessionFile,
    tokensBefore: opts.tokensBefore ?? null,
    firstKeptEntryId: opts.firstKeptEntryId ?? null,
    entries: opts.entries.length,
    chars: conversation.length,
    index,
  };
  const conversationPath = path.join(dir, "conversation.md");
  const metaPath = path.join(dir, "meta.json");
  fs.writeFileSync(conversationPath, conversation, "utf8");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return { dir, conversationPath, metaPath, chars: conversation.length };
}

function safeSessionFile(ctx: { sessionManager?: { getSessionFile?: () => string | null } }): string | null {
  try {
    return ctx.sessionManager?.getSessionFile?.() ?? null;
  } catch {
    return null;
  }
}

// Dumps can contain credentials, private code, and conversation history. Warn
// once per process per dump root when dumps land inside a git worktree whose
// ignore rules do not cover them. An explicit override pointing outside the
// project is the user's deliberate choice and is not warned about.
const gitWarnedRoots = new Set<string>();
function warnIfDumpsNotIgnored(cwd: string, notify?: (msg: string, level: "info" | "warning" | "error") => void): void {
  if (!notify || !cfg.warnGitIgnore) return;
  const cwdAbs = path.resolve(cwd);
  const rootAbs = path.resolve(dumpRoot(cwd));
  if (gitWarnedRoots.has(rootAbs)) return;
  if (!rootAbs.startsWith(cwdAbs + path.sep) && rootAbs !== cwdAbs) return;
  try {
    const inside = execFileSync("git", ["-C", cwdAbs, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (inside !== "true") return;
    gitWarnedRoots.add(rootAbs);
    const rel = path.relative(cwdAbs, rootAbs);
    let notIgnored = false;
    try {
      execFileSync("git", ["-C", cwdAbs, "check-ignore", "-q", "--", rel], {
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (e) {
      // exit 1 = not ignored; any other non-zero code is an error — don't warn on errors.
      notIgnored = (e as { status?: number }).status === 1;
    }
    if (notIgnored)
      notify(
        `verbatim-compact: dumps under ${rel} are not git-ignored in this repository and can contain credentials, private code, and conversation history — add ${rel}/ to .gitignore, or set MECH_COMPACT_DUMP_DIR to keep dumps outside the project`,
        "warning",
      );
  } catch {
    // git unavailable or not a repository: nothing to warn about.
  }
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
          // thinking blocks: removed by design (kept in the dump)
        }
        if (prose.trim()) lines.push(`[Assistant]: ${prose.trim()}`);
        if (calls.length > 0) lines.push(`[Assistant tool calls] (outputs removed): ${calls.join("; ")}`);
        break;
      }
      case "toolResult":
        // removed by design (kept in the dump)
        break;
      case "bashExecution":
        lines.push(`[BashExecution]: $ ${String(m.command ?? "")}  (output removed — see dump)`);
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
const SPAN_TRIMMED_NOTE = "(trimmed for size — see dump)";
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
 * (the base is opaque; the dump holds the truth).
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
 * remains in the dump.
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
    const stub = `${line.slice(0, 120)}…[truncated +${line.length - 120} chars — see dump]`;
    if (stub.length >= line.length) continue; // stubbing would not shrink it; step 3 drops it
    size += stub.length - line.length;
    items[i] = { ...items[i], line: stub };
  }
  // 3) drop oldest remaining lines until under budget (terminates: removes one per iteration)
  while (over() && items.length > 0) remove(0);

  return spans.map((_, span) => items.filter((it) => it.span === span).map((it) => it.line));
}

const REORIENT_BLOCK = `**Re-orient before continuing.** The dropped context contained the project's executed startup process. Re-run it now:
1. Redo the startup process described in the project instructions in your system prompt (AGENTS.md / CLAUDE.md): read the files it points you to and run the checks it asks for. Its text is still in your context; the results of having followed it are not. If no such instructions are in your system prompt, skip this step.
2. Run \`git status\` and review uncommitted work; re-verify build/test state if you are about to rely on it.
3. Re-read any file you are about to modify — do not trust content you only remember from before the compaction.
4. **Treat other pre-compaction knowledge as unverified too.** Tool outputs were removed. Anything you know only from them — or from earlier assistant prose describing them — is a note, not evidence. Before you state it as fact or base a decision on it, re-read the source or ask \`context_lookup\`. If you cannot verify it, say explicitly that it is unverified.

**Recovering dropped details.** Information removed from your active context is preserved in the transcript dump. Use \`context_lookup\` to recover relevant details, including earlier thinking and tool outputs. Do NOT grep the dump yourself in this conversation — that would fill your context with raw transcript text. Call the \`context_lookup\` tool with a specific question; a subagent greps the dump in its own context and returns only the relevant findings.`;

function buildMechanicalSummary(opts: {
  dumpDir: string;
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
}): string {
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
  if (base && base.summary.length > cfg.maxSummaryChars)
    opts.notify(
      `verbatim-compact: the base block alone is ${base.summary.length.toLocaleString()} chars (budget ${cfg.maxSummaryChars.toLocaleString()}); it is kept un-capped`,
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
  const lineBudget = Math.max(500, cfg.maxSummaryChars - overhead);
  const capped = capSpans(allSpans.map((s) => s.lines), lineBudget);

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
  parts.push(`- Latest: ${opts.now} (trigger: ${opts.reason}, ~${opts.tokensBefore.toLocaleString()} tokens before compaction)`);
  parts.push("- Kept: user messages verbatim, assistant text, tool calls as one-line signatures (arguments truncated). Removed: all assistant thinking and all tool outputs.");
  parts.push(
    "- pi keeps the most recent part of the conversation verbatim (its `keepRecentTokens` setting). The spans below cover only what came *before* that; everything after the last span is uncompacted.",
  );
  parts.push(`- Full transcript (all spans, thinking + tool outputs, untruncated): ${path.join(opts.dumpDir, "conversation.md")}`);
  parts.push("- Information removed from active context remains preserved in the transcript dump; recover it with `context_lookup` (including thinking and tool outputs).");
  parts.push("");
  parts.push(REORIENT_BLOCK);
  parts.push("");
  parts.push(SECTION_HEADER);
  parts.push("");
  parts.push(blocks.length > 0 ? blocks.join("\n\n") : "(no user or assistant prose in these spans — see dump)");
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
// context_lookup subagent: greps dumps in its own context, returns findings
// ============================================================================

interface DumpFile {
  /** directory name under .pi/context-dumps (or basename of an absolute path) */
  name: string;
  /** absolute path to conversation.md */
  file: string;
  /** raw content cache (physical lines) */
  lines: string[];
  /** dump-time entry index from meta.json; absent for pre-index dumps (scan fallback) */
  index?: DumpIndexEntry[];
}

function loadDumpFiles(dirs: string[]): DumpFile[] {
  const out: DumpFile[] = [];
  for (const dir of dirs) {
    const file = path.isAbsolute(dir) ? path.join(dir, "conversation.md") : dir.endsWith(".md") ? dir : path.join(dir, "conversation.md");
    try {
      const raw = fs.readFileSync(file, "utf8");
      let index: DumpIndexEntry[] | undefined;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "meta.json"), "utf8")) as { index?: unknown };
        if (Array.isArray(meta.index)) index = meta.index as DumpIndexEntry[];
      } catch {
        // pre-index dump: scanning fallback
      }
      out.push({ name: path.basename(path.dirname(file)), file, lines: raw.split("\n"), index });
    } catch {
      // missing file: skip
    }
  }
  return out;
}

/**
 * Entry (and section, for assistant entries) owning a 0-based line position.
 * Uses the dump-time index when present, so transcript content that looks like
 * ENTRY headers or ==== rules can no longer spoof attribution; falls back to
 * scanning for pre-index dumps.
 */
function entryAt(lines: string[], idx: number, index?: DumpIndexEntry[]): { id: string; header: string; section?: string } | undefined {
  const lineNo = idx + 1; // 1-based
  if (index && index.length > 0) {
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
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^ENTRY (\S+)  (.+)$/);
    if (m) return { id: m[1], header: lines[i] };
  }
  return undefined;
}

function listEntries(dumps: DumpFile[], file?: string): string {
  const targets = file ? dumps.filter((d) => d.name === file) : dumps;
  const parts: string[] = [];
  for (const d of targets) {
    let rows: string[];
    if (d.index && d.index.length > 0) {
      rows = d.index.map((e) => {
        const header = d.lines[e.startLine - 1] ?? "";
        const next = d.lines[e.startLine] ?? "";
        const preview = next.trim() !== "" && !next.startsWith(HR) ? `  ${next.trim().slice(0, 90)}` : "";
        return `${header}${preview}`;
      });
    } else {
      rows = d.lines.filter((l) => l.startsWith("ENTRY ")).map((l) => {
        const next = d.lines[d.lines.indexOf(l) + 1];
        const preview = next && !next.startsWith(HR) && next.trim() !== "" ? `  ${next.trim().slice(0, 90)}` : "";
        return `${l}${preview}`;
      });
    }
    parts.push(`### ${d.name} (${rows.length} entries)\n${rows.join("\n")}`);
  }
  return parts.join("\n\n") || "(no dump files)";
}

function grepDump(dumps: DumpFile[], opts: { pattern: string; file?: string; before?: number; after?: number; maxMatches?: number }): string {
  const targets = opts.file ? dumps.filter((d) => d.name === opts.file) : dumps;
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
  if (matches === 0) return `No matches for /${opts.pattern}/ in ${targets.map((t) => t.name).join(", ") || "(no dumps)"}.`;
  return truncateMiddle(out.join("\n\n"), cfg.grepMaxChars);
}

function showEntry(dumps: DumpFile[], opts: { id: string; file?: string; maxLines?: number }): string {
  const targets = opts.file ? dumps.filter((d) => d.name === opts.file) : dumps;
  const maxLines = Math.max(10, opts.maxLines ?? 400);
  const out: string[] = [];
  for (const d of targets) {
    let block: string[] | undefined;
    if (d.index && d.index.length > 0) {
      const e = d.index.find((x) => x.id === opts.id);
      if (e) block = d.lines.slice(e.startLine - 2, e.endLine); // includes the HR line before the header
    } else {
      const start = d.lines.findIndex((l) => l.startsWith(`ENTRY ${opts.id} `) || l === `ENTRY ${opts.id}`);
      if (start >= 0) {
        // block starts at the HR line just before the header (if any)
        const from = start > 0 && d.lines[start - 1].startsWith(HR) ? start - 1 : start;
        let end = d.lines.length;
        for (let i = start + 1; i < d.lines.length; i++) {
          if (d.lines[i].startsWith(HR)) {
            end = i;
            break;
          }
        }
        block = d.lines.slice(from, end);
      }
    }
    if (!block) continue;
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
  dumps: DumpFile[];
  model: Model;
  registry: ModelRegistry;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const toc = truncateMiddle(listEntries(opts.dumps).split("\n").slice(0, 60).join("\n"), 4_000);

  const tools: AiTool[] = [
    {
      name: "list_entries",
      description: "List every ENTRY header in the transcript (id, role, timestamp, first-line preview). Optional `file` restricts to one dump directory name.",
      parameters: Type.Object({
        file: Type.Optional(Type.String({ description: "Dump directory name (see transcript file list). Omit for all." })),
      }),
    },
    {
      name: "grep",
      description: "Regex-search the transcript lines. Returns matching lines with surrounding context and entry attribution. `pattern` is a JS regex (case-insensitive).",
      parameters: Type.Object({
        pattern: Type.String({ description: "JS regex, case-insensitive" }),
        file: Type.Optional(Type.String({ description: "Dump directory name. Omit for all." })),
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
        file: Type.Optional(Type.String({ description: "Dump directory name. Omit for all." })),
        maxLines: Type.Optional(Type.Number({ description: "Max lines to return (default 400)" })),
      }),
    },
  ];

  const messages: AiMessage[] = [
    {
      role: "user",
      content:
        `Question: ${opts.question}\n\n` +
        `Transcript files (full pre-compaction dumps; ENTRY blocks are anchored by entry id):\n` +
        opts.dumps.map((d) => `- ${d.file}`).join("\n") +
        `\n\nTranscript overview (first entries; call list_entries for the full list):\n${toc}`,
      timestamp: Date.now(),
    },
  ];

  const dispatch = (name: string, args: Record<string, any>): string => {
    try {
      switch (name) {
        case "list_entries":
          return listEntries(opts.dumps, args.file);
        case "grep":
          return grepDump(opts.dumps, args);
        case "show_entry":
          return showEntry(opts.dumps, args);
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
// Dump resolution (for context_lookup)
// ============================================================================

function dumpRoot(cwd: string): string {
  return dumpDirOverride ?? path.join(cwd, ...DUMP_ROOT_PARTS);
}

function listDumpDirs(cwd: string): string[] {
  try {
    return fs
      .readdirSync(dumpRoot(cwd), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function dumpSessionFile(dir: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { sessionFile?: unknown };
    return typeof meta.sessionFile === "string" ? meta.sessionFile : null;
  } catch {
    return null;
  }
}

function dumpMetaTime(dir: string): number {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { timestamp?: unknown };
    const t = Date.parse(String(meta.timestamp ?? ""));
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * The set of session entry ids a parsed dump meta indexes, or null when the
 * meta has no index (pre-index dump). Ids missing from index entries (the
 * session header has none) are ignored.
 */
function indexIdSet(meta: { index?: unknown }): Set<string> | null {
  if (!Array.isArray(meta.index)) return null;
  const ids = new Set<string>();
  for (const item of meta.index) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

/**
 * The set of session entry ids a dump contains, read from its meta.json.
 * Returns null for a pre-index dump or an unreadable/invalid meta.json.
 */
function dumpIndexIds(dir: string): Set<string> | null {
  try {
    return indexIdSet(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { index?: unknown });
  } catch {
    return null;
  }
}

/** The first session entry id on the branch (the session header has none). */
function firstEntryId(entries: SessionEntry[]): string | null {
  for (const e of entries) {
    const id = (e as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/** All session entry ids a branch contains (entry ids are random per entry). */
function entryIdSet(entries: SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    const id = (e as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

/**
 * Ownership: does a dump dir under `root` belong to the current session?
 * Indexed dumps match when their index contains the branch's first entry id
 * (entry ids are random per session, so other sessions' dumps never match —
 * and ephemeral sessions are scoped too). Pre-index dumps fall back to the
 * meta.json sessionFile comparison, and only when the current session has a
 * file; without one they are excluded.
 */
function dumpOwnership(root: string, sessionFile: string | null, firstId: string | null): (name: string) => boolean {
  return (name: string): boolean => {
    const dir = path.join(root, name);
    const ids = dumpIndexIds(dir);
    if (ids !== null) return firstId !== null && ids.has(firstId);
    return sessionFile !== null && dumpSessionFile(dir) === sessionFile;
  };
}

/**
 * Prune dumps that are provably contained in the dump just written, after the
 * new dump is fully on disk. Every dump re-serializes the whole branch, so on
 * the same branch each new dump is a superset of earlier ones; the redundant
 * copies waste disk and make dumpDir:"all" return duplicate matches. A
 * candidate is deleted only if EVERY entry id in its index is present in the
 * new dump — so dumps holding /tree-abandoned branches, pre-index dumps,
 * unreadable metas, and other sessions' dumps are never touched. Pruning
 * failures never fail or alter the compaction; they are reported only.
 */
function pruneRedundantDumps(opts: {
  cwd: string;
  newDumpDir: string;
  newIds: Set<string>;
  sessionFile: string | null;
  firstId: string | null;
  notify?: (msg: string, level?: "info" | "warning" | "error") => void;
}): void {
  const { cwd, newDumpDir, newIds, sessionFile, firstId, notify } = opts;
  try {
    const root = dumpRoot(cwd);
    const rootReal = fs.realpathSync(root);
    const newReal = fs.realpathSync(newDumpDir);
    const owns = dumpOwnership(root, sessionFile, firstId);
    const unreadable: string[] = [];
    let removed = 0;
    for (const name of listDumpDirs(cwd)) {
      const dir = path.join(root, name);
      let real: string;
      try {
        real = fs.realpathSync(dir);
      } catch {
        continue; // vanished mid-scan: leave it
      }
      if (real === newReal) continue; // the dump just written
      if (!real.startsWith(rootReal + path.sep)) continue; // only ever delete inside the dump root
      let meta: { index?: unknown };
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { index?: unknown };
      } catch {
        unreadable.push(name);
        continue; // unreadable meta.json: never touch, report below
      }
      const ids = indexIdSet(meta);
      if (ids === null || ids.size === 0) continue; // pre-index (or no ids): containment not provable
      if (!owns(name)) continue; // other session's dump: never touch
      let contained = true;
      for (const id of ids) if (!newIds.has(id)) { contained = false; break; }
      if (!contained) continue; // holds entries the new dump lacks (e.g. an abandoned branch)
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
    if (unreadable.length > 0) {
      notify?.(`verbatim-compact: pruning skipped ${unreadable.length} dump dir(s) with unreadable meta.json: ${unreadable.join(", ")}`, "warning");
    }
    if (removed > 0) {
      notify?.(`verbatim-compact: pruned ${removed} redundant dump(s) — every entry is in the new dump`, "info");
    }
  } catch (err) {
    notify?.(`verbatim-compact: dump pruning failed (${errMsg(err)}); older dumps kept`, "warning");
  }
}

/**
 * Resolve which dump conversation.md files to search.
 * Dumps are scoped to the current session by entry-id overlap (see
 * dumpOwnership): a dump's meta.json index must contain the current branch's
 * first entry id; pre-index dumps fall back to the meta.json sessionFile
 * match, and are excluded when the current session has no file. Explicit
 * directory names or absolute paths bypass scoping (the caller chose them
 * deliberately).
 * - explicit dir name or absolute path
 * - "all" -> every non-redundant dump of this session (redundant dumps are
 *   pruned after each write; unique value: /tree-abandoned branches)
 * - default -> dump recorded on the newest mech-compact entry in the branch, else newest dir of this session
 */
function resolveDumpFiles(
  ctx: { cwd: string; sessionManager?: { getBranch?: () => SessionEntry[]; getSessionFile?: () => string | null } },
  dumpDir?: string,
): string[] {
  const root = dumpRoot(ctx.cwd);
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const owns = dumpOwnership(root, safeSessionFile(ctx), firstEntryId(branch));
  const names = listDumpDirs(ctx.cwd).filter(owns);

  if (dumpDir && dumpDir !== "all") {
    if (path.isAbsolute(dumpDir)) return [dumpDir];
    const p = path.join(root, dumpDir);
    return fs.existsSync(path.join(p, "conversation.md")) ? [p] : [];
  }
  if (dumpDir === "all") return names.map((n) => path.join(root, n));

  // default: newest mech-compact entry's dumpDir, else newest directory of this session
  try {
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type === "compaction") {
        const d = (e as { details?: { kind?: string; dumpDir?: string } }).details;
        if (d?.kind === MECH_KIND && d.dumpDir && fs.existsSync(path.join(d.dumpDir, "conversation.md"))) return [d.dumpDir];
      }
    }
  } catch {
    // fall through to newest dir
  }
  if (names.length === 0) return [];
  // "newest" by meta.json timestamp (dir names carry a random suffix, so
  // lexicographic order is not chronological within the same second)
  const stamped = names
    .map((n) => ({ n, t: dumpMetaTime(path.join(root, n)) }))
    .sort((a, b) => b.t - a.t);
  return [path.join(root, stamped[0].n)];
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // --------------------------------------------------------------------------
  // Mechanical compaction
  // --------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, reason, signal } = event;
    if (!preparation) return;
    if (signal?.aborted) return;
    if (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0) return;

    // 1) Dump the full pre-compaction branch (full fidelity) first.
    let dump: DumpInfo;
    try {
      dump = writeDump({
        entries: branchEntries,
        cwd: ctx.cwd,
        sessionFile: safeSessionFile(ctx),
        reason,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId: preparation.firstKeptEntryId,
      });
    } catch (err) {
      ctx.ui?.notify?.(`verbatim-compact: dump failed (${errMsg(err)}); falling back to default compaction`, "error");
      return;
    }
    // 1b) Prune older dumps this one supersedes (never affects the compaction).
    pruneRedundantDumps({
      cwd: ctx.cwd,
      newDumpDir: dump.dir,
      newIds: entryIdSet(branchEntries),
      sessionFile: safeSessionFile(ctx),
      firstId: firstEntryId(branchEntries),
      notify: (m, level) => ctx.ui?.notify?.(m, level),
    });
    // 1c) Security note: warn once if dumps land in a git repo that doesn't ignore them.
    warnIfDumpsNotIgnored(ctx.cwd, (m, level) => ctx.ui?.notify?.(m, level));

    // 2) Cumulative file lists: pi only carries lists from pi-generated
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

      // 3) The new span. Pi's preparation span is [previous cut, current cut)
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

      // 4) Build the mechanical summary (no LLM call).
      const summary = buildMechanicalSummary({
        dumpDir: dump.dir,
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
      });

      ctx.ui?.notify?.(
        `verbatim-compact: ~${preparation.tokensBefore.toLocaleString()} tokens -> verbatim checkpoint; full dump at ${dump.dir}`,
        "info",
      );

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            kind: MECH_KIND,
            dumpDir: dump.dir,
            readFiles,
            modifiedFiles,
            // Only this compaction's own span (un-capped lines). Earlier spans
            // are re-rendered from the earlier entries' details — no nesting.
            span: { at: nowIso, from: spanFrom, to: spanTo, reason, tokensBefore: preparation.tokensBefore, lines: spanLines },
          },
        },
      };
    } catch (err) {
      ctx.ui?.notify?.(`verbatim-compact: failed to build checkpoint (${errMsg(err)}); falling back to default compaction`, "error");
      return;
    }
  });

  // --------------------------------------------------------------------------
  // On-demand dump: /dump-context command + dump_context tool
  // --------------------------------------------------------------------------
  const doDump = async (
    ctx: {
      cwd: string;
      sessionManager?: { getBranch?: () => SessionEntry[]; getSessionFile?: () => string | null };
      ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
    },
    note?: string,
  ): Promise<DumpInfo> => {
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const sessionFile = safeSessionFile(ctx);
    const info = writeDump({
      entries,
      cwd: ctx.cwd,
      sessionFile,
      reason: note ? `on-demand: ${note}` : "on-demand",
    });
    pruneRedundantDumps({
      cwd: ctx.cwd,
      newDumpDir: info.dir,
      newIds: entryIdSet(entries),
      sessionFile,
      firstId: firstEntryId(entries),
      notify: (m, level) => ctx.ui?.notify?.(m, level),
    });
    warnIfDumpsNotIgnored(ctx.cwd, (m, level) => ctx.ui?.notify?.(m, level));
    return info;
  };

  pi.registerCommand("dump-context", {
    description: "Dump the full current context (thinking + tool outputs) to .pi/context-dumps/ without compacting",
    handler: async (args, ctx) => {
      try {
        const info = await doDump(ctx, args?.trim() || undefined);
        ctx.ui.notify(`Context dumped to ${info.conversationPath} (${(info.chars / 1000).toFixed(1)}k chars)`, "info");
      } catch (err) {
        ctx.ui.notify(`dump-context failed: ${errMsg(err)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "dump_context",
    label: "Dump context",
    description:
      "Snapshot the entire current session context (including thinking blocks and full tool outputs) to <project>/.pi/context-dumps/<timestamp>_<id>/conversation.md. Use when the user asks to save/dump/snapshot the current context, or before work that risks context overflow. Returns the dump directory.",
    promptSnippet: "Dump the full current context to .pi/context-dumps/ for later grepping",
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: "Optional note recorded in meta.json" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const info = await doDump(ctx, params.note);
        return {
          content: [{ type: "text", text: `Context dumped to ${info.conversationPath} (${info.chars} chars). Grep it with: rg <pattern> ${info.dir}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `dump_context failed: ${errMsg(err)}` }] };
      }
    },
  });

  // --------------------------------------------------------------------------
  // context_lookup tool: subagent research over the dumps
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "context_lookup",
    label: "Context lookup",
    description:
      "Recover information preserved in transcript dumps but removed from your active context by verbatim compaction—including thinking, tool outputs, error text, file contents, and earlier decisions. Spawns a subagent that greps the full pre-compaction dump(s) in .pi/context-dumps/ in its OWN context and returns only the relevant findings. Do NOT grep the dumps yourself in the main conversation.",
    promptSnippet: "Ask a subagent to research dropped context in the pre-compaction dumps",
    parameters: Type.Object({
      question: Type.String({ description: "What to find in the dropped context. Be specific (exact error text, file, decision, command output…)." }),
      dumpDir: Type.Optional(
        Type.String({ description: "Dump directory name or absolute path to search. Default: the dump referenced by the latest verbatim checkpoint. Every dump re-serializes the whole branch, so the default already covers the session's full history. \"all\" searches every non-redundant dump of this session (superseded dumps are pruned after each write) — rarely needed; the one case it uniquely helps is history of a branch abandoned via /tree. Dumps are scoped to this session by entry-id overlap." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const files = resolveDumpFiles(ctx, params.dumpDir);
      if (files.length === 0) {
        return { content: [{ type: "text", text: `No context dumps found under ${dumpRoot(ctx.cwd)}/. Verbatim compaction creates them; /dump-context can create one now.` }] };
      }
      const dumps = loadDumpFiles(files);
      if (dumps.length === 0) {
        return { content: [{ type: "text", text: "Dump directories found but no readable conversation.md files." }] };
      }

      let model: Model | undefined;
      if (cfg.lookupModel) {
        const slash = cfg.lookupModel.indexOf("/");
        if (slash > 0) model = ctx.modelRegistry.find(cfg.lookupModel.slice(0, slash), cfg.lookupModel.slice(slash + 1));
      }
      model = model ?? ctx.model;
      if (!model) {
        return { content: [{ type: "text", text: "context_lookup needs a model (session model or MECH_COMPACT_LOOKUP_MODEL)." }] };
      }

      try {
        const answer = await runLookupSubagent({ question: params.question, dumps, model, registry: ctx.modelRegistry, signal });
        return { content: [{ type: "text", text: answer }] };
      } catch (err) {
        return { content: [{ type: "text", text: `context_lookup failed: ${errMsg(err)}` }] };
      }
    },
  });
}
