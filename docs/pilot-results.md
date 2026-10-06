# Pilot: verbatim vs model-summary compaction

These are the author's preliminary synthetic stress-test results. The full
model-quality evaluation is in progress; it is not included in the package's
integration test suite. Compaction timings below exclude subsequent lookup
work. The local deployment example in the README is not a separate hardware
benchmark.

**Implementation note:** this historical pilot used separate transcript dumps
for lookup. The current release instead renders Pi's raw session branch in memory
when lookup is called. The figures below have not been re-measured for that
implementation; descriptions of dumps below refer to the pilot's implementation.

## Does the agent know what it lost?

We gave a coding agent long debugging sessions, compacted its context three times, and after each compaction asked it about details from the start of the session. We compared pi's default compaction (a model-written summary) with **verbatim-compact**, which retains user messages and assistant text (subject to a size guard), removes thinking and tool outputs from active context, and preserves those in dumps searchable through a `context_lookup` tool.

### The test

- **10 sessions across 5 debugging stories:** a CI pipeline timing out after test sharding, a database migration blocked by locks, a websocket gateway leaking memory, a checkout release that may need a rollback, and a thumbnail service hit by a cache stampede.
- **17 details per session that a summary is likely to drop or blur.** Each was planted early in the session:
  - an error code seen once in a log;
  - an id that appears in two different logs;
  - a flaky test you can only identify by comparing two test runs;
  - a number mentioned in passing;
  - values that change twice;
  - things noted only in the agent's private reasoning;
  - asides about hosts and people.

  Each session also has 3 questions about things never discussed, which test whether the agent invents answers.
- **Three rounds of further work**, each followed by a compaction and a probe. Each round is about 30k tokens of log reads, test runs and config checks, full of look-alike codes, hashes, hosts and names. It opens with an episode that competes with the original details: a second, similar experiment, a second version pin, a new contact and deadline.
- **Same model** (Qwen3.8-27B, local llama.cpp) and same settings for both methods. A full-context run with no compaction gives the reference ceiling.

### Results

| | After compaction 1 | After compaction 2 | After compaction 3 |
|---|---|---|---|
| **pi default:** recall | 83% (141/170) | 79% (134/170) | 79% (134/170) |
| **pi default:** confident wrong answers | 6 | 13 | 14 |
| **verbatim-compact:** recall | 97% (165/170) | 99% (168/170) | 99% (151/153) |
| **verbatim-compact:** confident wrong answers | 0 | 1 | 0 |

Full context, no compaction: 96% (163/170), 3 wrong. Neither method invented an answer to any of the 3 never-discussed questions per session.

| Cost per compaction (median) | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| pi default | 204 s | 345 s | 372 s |
| verbatim-compact | 1.1 s | 0.8 s | 0.8 s |

**What happens to the model summary:** it loses about a sixth of the details at the first compaction and never gets them back. After that, its errors change kind: instead of saying it doesn't know, it fills the gap with a plausible neighbour. Confident wrong answers more than double after the second compaction. Some examples:

- *"What is the newest ws library version we may use?"* The truth was **8.14.9**. After the second compaction the agent answered **20.48.4**, the version of a *different* library pinned in a later round.
- *"How many rows per statement was the backfill updating when we found the long locks?"* The truth was **60,000**. In every round the agent answered **250,000**, the batch size tried *next*.
- *"Which rate limit did we try first that made things worse?"* The truth was **400**. After the second and third compactions the agent answered **350**, the value from a different component's experiment. After the third it even labelled the answer "(shipping-quote)", the name of that other component.
- *"Which connection had the largest buffer in both crashes?"* After the third compaction the agent gave the id from a *different* pair of crashes that came up later in the session.

**What happened with verbatim-compact in this pilot:** retained user messages and assistant prose were carried forward without model rewriting; the original textual evidence remained in transcript dumps. When a detail isn't in the checkpoint, the agent either looks it up or says it doesn't know, and it can say why:

> UNKNOWN — the TTL change is commit 47ab0c9 "lower thumbnail cache TTL to 60s", but its author was never shown or discussed.

Because the dumped evidence remains available, a miss in one round can come out right in the next. In this pilot, errors introduced by the model summary could persist through later summaries.

### Caveats

- **This is a stress test, not a benchmark.** The sessions are synthetic and the details were chosen as the kind summaries tend to lose, so the numbers show how the methods behave under that pressure, not how often it happens in real work.
- **The probes ask 20 recall questions at once**, which is unrealistic. verbatim-compact answers them with many lookups: its median probe took about 7 minutes (2 of 30 hit our 30-minute limit; one was re-run once with a different seed, the other is excluded), against about 1 minute for the summary. In normal use you'd look something up occasionally, when needed, while verbatim-compact's compaction itself is near-instant.
- **One model, one sample per question.** The full-context reference also makes errors (3 here, from near-duplicate details), so neither method should be expected to score 100%.
- **Two flawed questions were neutralised for both methods.** In one story the generated config contradicted a planted detail, and in another a later re-read of a file contradicted it. Answers to those two questions were scored leniently for both methods.
