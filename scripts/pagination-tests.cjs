"use strict";
const assert = require("node:assert/strict");

module.exports = async function paginationTests(h) {
  const { ext, SessionManager, root, makeContext, user, text, toolText, search, toolCall } = h;
  console.log("== Bounded retrieval: exact continuation, all matches, long entries/lines, and subagent parity ==");
  const manager = SessionManager.inMemory(root);
  const ctx = makeContext(manager, root);
  const call = async (name, args) => toolText(await ext.tools[name].execute("page", args, undefined, undefined, ctx));
  const strip = (result) => result.replace(/^\[Continuation: [^\n]*\]\n/, "").split("\n[Page limited:")[0];
  const collect = async (name, args, budget) => {
    let offset = 0, throughEntry, reconstructed = "", pages = 0;
    for (;;) {
      const result = await call(name, { ...args, offset, ...(throughEntry ? { throughEntry } : {}) });
      const payload = strip(result);
      assert(payload.length <= budget, "character guard applies to the payload on every page");
      if (offset) assert(result.startsWith("[Continuation:"), "continued entries/listings retain attribution");
      reconstructed += payload;
      const next = /Continue with the same parameters and offset=(\d+)(?:, throughEntry="([^"]+)")?\.\]$/.exec(result);
      pages++;
      assert(pages < 1000, "pagination always terminates");
      if (!next) break;
      assert(Number(next[1]) > offset, "cursor always advances");
      assert(result.includes("characters remain"));
      offset = Number(next[1]);
      throughEntry = next[2];
      if (name === "context_list_entries") {
        assert(throughEntry, "listing cursors pin the source boundary");
        manager.appendMessage(user("PAGE_APPENDED_ONLY must not appear in this listing"));
      }
    }
    return { reconstructed, pages, offset };
  };

  const huge = "BIG_OUTPUT_START\n" + "long line " + "0123456789".repeat(6000) + "\n" + "multi-line output\n".repeat(1000) + "BIG_OUTPUT_END";
  const id = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "huge-read", content: [text(huge)], isError: false, timestamp: Date.now() });
  const entry = manager.getEntry(id);
  const expected = `### session\n${"=".repeat(78)}\nENTRY ${id}  toolResult (read, isError=false)  ${entry.timestamp}\n${huge}\n`;
  const shown = await collect("context_show_entry", { id, maxLines: 17 }, 24000);
  assert.equal(shown.reconstructed, expected, "every character survives both line and character pagination");
  assert(shown.pages > 3);
  assert((await call("context_show_entry", { id, offset: expected.length })).startsWith("No more content"));

  const first = await call("context_show_entry", { id });
  const secondOffset = Number(/and offset=(\d+)\.\]$/.exec(first)[1]);
  const second = await call("context_show_entry", { id, offset: secondOffset });
  assert(second.includes(`ENTRY ${id}  toolResult`), "continuation repeats authoritative attribution even inside a single line");
  await search(ext, ctx, [
    toolCall("show_entry", { id }),
    toolCall("show_entry", { id, offset: secondOffset }),
  ], (results) => assert.deepEqual(results, [first, second], "subagent and fallback share cursors and payloads"));

  // Character boundaries have no gaps or duplicate payload, even exactly at the cap.
  for (const length of [24000, 24001, 48000]) {
    const boundaryId = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: `boundary-${length}`, content: [text("x")], isError: false, timestamp: Date.now() });
    const small = await call("context_show_entry", { id: boundaryId });
    manager.getEntry(boundaryId).message.content[0].text = "x".repeat(length - small.length + 1);
    const boundary = await collect("context_show_entry", { id: boundaryId }, 24000);
    assert.equal(boundary.reconstructed.length, length);
    assert.equal(boundary.pages, Math.ceil(length / 24000));
  }

  const unicodeId = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "unicode", content: [text("x")], isError: false, timestamp: Date.now() });
  const overhead = (await call("context_show_entry", { id: unicodeId })).length - 2; // payload and trailing newline
  const unicode = "x".repeat(24000 - overhead - 1) + "😀".repeat(14000);
  manager.getEntry(unicodeId).message.content[0].text = unicode;
  const unicodeFirst = await call("context_show_entry", { id: unicodeId });
  assert.equal(strip(unicodeFirst).length, 23999, "a high surrogate at the cap is deferred to the next page");
  const unicodePages = await collect("context_show_entry", { id: unicodeId }, 24000);
  assert(unicodePages.reconstructed.includes(unicode), "Unicode characters survive pagination intact");

  for (let i = 0; i < 500; i++) manager.appendMessage(user(`LIST_ROW_${i} ` + "p".repeat(100)));
  const listedEntries = manager.getBranch();
  const listing = await collect("context_list_entries", {}, 12000);
  assert(listing.pages > 1);
  for (const e of listedEntries) assert(listing.reconstructed.includes(`ENTRY ${e.id} `));
  assert.equal((listing.reconstructed.match(/^ENTRY /gm) ?? []).length, listedEntries.length, "no entry disappears or duplicates across pages");
  assert(!listing.reconstructed.includes("PAGE_APPENDED_ONLY"), "newly appended calls/results do not move the listing boundary or count header");
  const firstList = await call("context_list_entries", {});
  const listCursor = /and offset=(\d+), throughEntry="([^"]+)"\.\]$/.exec(firstList);
  const listArgs = { offset: Number(listCursor[1]), throughEntry: listCursor[2] };
  const laterList = await call("context_list_entries", listArgs);
  await search(ext, ctx, [toolCall("list_entries", listArgs)], ([result]) => assert.equal(result, laterList));
  assert((await call("context_list_entries", { throughEntry: "not-on-this-branch" })).includes("Restart at offset=0"));

  const matchId = manager.appendMessage(user(Array.from({ length: 37 }, (_, i) => `BATCH_MATCH_${i}`).join("\n")));
  const pattern = "^BATCH_MATCH_[0-9]+$";
  let offset = 0, pages = 0, throughEntry;
  const found = [];
  for (;;) {
    const result = await call("context_grep", { pattern, before: 0, after: 0, maxMatches: 5, offset, throughEntry });
    assert(result.includes(`ENTRY ${matchId}  user`));
    found.push(...[...result.matchAll(/^>> (BATCH_MATCH_\d+)$/gm)].map((m) => m[1]));
    pages++;
    const next = /offset=(\d+), charOffset=(\d+), throughEntry="([^"]+)"\.\]$/.exec(result);
    if (!next) break;
    assert(result.includes("37 total matches"), "omitted matches are explicitly counted");
    assert.equal(Number(next[2]), 0);
    assert(Number(next[1]) > offset);
    offset = Number(next[1]);
    throughEntry = next[3];
    manager.appendMessage(user("BATCH_MATCH_999999"));
  }
  assert.equal(pages, 8);
  assert.deepEqual(found, Array.from({ length: 37 }, (_, i) => `BATCH_MATCH_${i}`));
  assert((await call("context_grep", { pattern, offset: 37, throughEntry })).startsWith("No more matches"));
  assert((await call("context_grep", { pattern, charOffset: 999999 })).startsWith("Invalid charOffset"));

  const giantLine = "ONE_GIANT_MATCH_" + "z".repeat(40000) + "_END";
  const giantId = manager.appendMessage(user(giantLine));
  let charOffset = 0, joined = "";
  for (let page = 0; ; page++) {
    assert(page < 10);
    const result = await call("context_grep", { pattern: "^ONE_GIANT_MATCH_", before: 0, after: 0, offset: 0, charOffset });
    assert(result.includes(`ENTRY ${giantId}  user`), "every partial-match page preserves trusted attribution");
    const payload = result.slice(result.indexOf("\n") + 1).split("\n[Page limited:")[0];
    joined += payload;
    assert(result.split("\n[Page limited:")[0].length <= 12000);
    const next = /offset=(\d+), charOffset=(\d+), throughEntry="([^"]+)"\.\]$/.exec(result);
    if (!next) break;
    assert(result.includes("including the partially shown match"));
    assert.equal(Number(next[1]), 0);
    assert(Number(next[2]) > charOffset);
    charOffset = Number(next[2]);
  }
  assert.equal(joined, ">> " + giantLine, "long matching lines remain fully accessible");
  const grepArgs = { pattern, before: 0, after: 0, maxMatches: 3, offset: 15 };
  const directGrep = await call("context_grep", grepArgs);
  await search(ext, ctx, [toolCall("grep", grepArgs)], ([result]) => assert.equal(result, directGrep));
};
