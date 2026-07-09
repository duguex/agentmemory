# Improvements Tracker

> Change history for the agentmemory backfill observations and
> search quality. Updated 2026-07-10.

## What the system looks like now

| Metric | Value |
|---|---|
| Observations | 2460 backfill (100% LLM-compressed) |
| Sessions | 94 backfill + active |
| Search quality (R@10 / MRR) | 29.6% / 0.224 on 16-query labeled set |
| Daemon | healthy, single process, circuit closed |
| DLQ | 0 (was 5538, drained 2026-07-08) |
| Open issues | 21 (15 pre-existing + 6 from this work) |

For a one-line status, run `bash scripts/status.sh`.
For the full picture, see `docs/architecture.md` and
`docs/known-issues.md`.

## Phase 1 — DLQ cleanup

**Goal**: stop DLQ growth, clear the existing 5538-message
backlog from the 7/4-7/7 schema-lock disaster.

| What | Commit | Notes |
|---|---|---|
| `compress.ts:90` now returns `{success: true, skipped: true, reason: "orphan_observation"}` on missing KV entries instead of throwing | `e769842` | Orphans no longer enter the 3-retry → DLQ path. |
| `iii-config.yaml`: `max_retries: 3 → 1`, `backoff_ms: 5000 → 2000` | `e769842` | Less wasted time per failure. |
| `scripts/drain-dlq.py`: paginate + snapshot + discard idempotently | `e769842` | The script also has a fix at `735b4f0` (see Phase 1.5 below). |
| DLQ 5538 → 0 in ~4 minutes | (operational) | Verified by `iii trigger engine::queue::topic_stats`. |

**Phase 1.5** (unplanned): `drain-dlq.py` initially paginated with
`offset += page_size`, but iii-queue's DLQ is sorted and
discarded messages are removed from the list, so `offset=N`
returns empty after the first N are discarded. Fix at
`735b4f0`: always re-page from offset 0 with dedup.

## Phase 2 — Retrieval quality

**Goal**: stop the 41.7% R@10 placebo numbers, give the eval
real signal, fix rerank, and wire query expansion.

| What | Commit | Notes |
|---|---|---|
| `reranker.ts` uses cross-encoder pair API (`{text, text_pair}`) instead of concatenating into a single string. Parallel scoring with 250ms per-pair timeout. 70/30 blend with original `combinedScore` to avoid catastrophic reordering. | `04e701c` | The previous implementation scored "is this string relevant to itself". Now scores real relevance. |
| `index.ts:381` explicitly passes `rerankEnabled` to `HybridSearch` (was relying on the env default = false) | `04e701c` | Rerank now actually runs by default. |
| `benchmark/backfill-quality-eval.ts` rewritten: 16 hand-labeled queries, 5 categories, observation-level + session-level metrics, NDCG, HitRate, full UUID match | `04e701c` | The old eval had 3 bugs that made numbers meaningless: empty-relevance = 1.0, fuzzy UUID match, session-level only. |
| `smart-search.ts` triggers `mem::expand-query` (200ms budget) and routes through `HybridSearch.searchWithExpansion` | `d9a5b52` | Query expansion is reachable. The function was registered but unused before this. |
| `benchmark/tune-weights.sh`: grid search across BM25/vector weights | `52f231a` | Verified the default `0.4 / 0.6 / 0.3` is near-optimal for the VASP benchmark. |

**Result**: Session R@10 = 29.6%, MRR = 0.224. Two queries hit
100% (VASP binary cleanup, find large files). The 41.7% /
0.200 numbers in `benchmark/QUALITY.md` were inflated by the
empty-label bug — that file is stale now (issue #62).

**Caveat**: Query expansion adds +40% latency for neutral
precision on the VASP benchmark. See known-issues #7.

## Phase 3 — Corpus quality

**Goal**: improve the content of LLM-compressed observations.

| What | Commit | Notes |
|---|---|---|
| `prompts/compression.ts`: strict importance rubric (1-3 routine, 4-6 normal, 7-9 decisions, 10 breaking), 2-5 searchable concepts, dedup rules, "optimize for findability" preamble | `8756a5b` | |
| `prompts/summary.ts`: add `<tags>` field, lead-with-decision narrative rule, override semantics in REDUCE | `8756a5b` | Tags live in the existing XML schema — no parser change needed. |
| `providers/openai.ts`: `temperature: 0` default, 2 retries on 429/5xx/timeout with exponential backoff | `8756a5b` | Corpus is stable across re-compression runs. |

**Verified live** (POSTed a test `ls -la` obs to fresh daemon):

| Field | Old prompt | New prompt |
|---|---|---|
| `title` | "Synthetic observation" or vague | "ls -la /home/duguex/.agentmemory/data/" |
| `importance` | 4-6 (rubric ignored) | **2** (correct: routine ls) |
| `concepts` | 0-1 generic | 3 specific terms |
| `narrative` | "Command completed" | Natural language describing what happened |

**Important**: The 2460 existing backfill observations were
processed with the **old** prompt. Re-compressing them with the
Phase 3 prompt is the highest-leverage remaining work for
retrieval quality. Estimated: ~10 hours background via
`scripts/upgrade-backfill-compression.py`.

## Phase 4 — Pending issues from prior code reviews

15 pre-existing issues, all fixed in commits on
`feat/omp-adaptation`:

| Issue | What | Commit |
|---|---|---|
| #56 | `setTimeout` in OMP session_shutdown missing `.unref()` | `a8a5a99` |
| #53 | `JSON.stringify(event.result)` loses Error details | `28c13cb` |
| #27, #55 | OMP `serverOk` was a sticky latch | `a8a5a99` |
| #21 | OMP `currentProject` didn't refresh on `cd` | `00b0d89` |
| #22, #23 | OMP `agent_start`/`agent_end` asymmetric lifecycle | `00b0d89` |
| #25 | OMP `systemPrompt=""` produced stray newline | `a8a5a99` |
| #54 | OMP URL prefix detection by hostname substring | `00b0d89` |
| #28 | OMP `apiGet` sent `Content-Type` on body-less GET | `00b0d89` |
| #52 | OMP `Promise.withResolvers` requires Node 22+ | `00b0d89` |
| #33 | `getAutoForgetIntervalMs`/`getEvictIntervalMs` duplicated `safeParseInt` | `2f164f8` |
| #32 | `AUTO_FORGET_INTERVAL_MS` rename had no migration path | `2f164f8` + `7d54c91` |
| #29 | OMP `maybeWarnPlaintextBearer` dead function body | `a8a5a99` |
| #57 | `auto-compress.test.ts` env-isolation bug | `e181610` |

**22 issues closed** in total (15 pre-existing + 7 new from this
work). GitHub issue list is now empty.

## Phase 5 — Queue hold behavior

**Goal**: distinguish "LLM is briefly unavailable" (hold and
retry) from "request is malformed" (retry and DLQ).

| What | Commit | Notes |
|---|---|---|
| `OpenAIProvider.isLlmUnavailable(err)` static method detects Ollama "model not found" / ECONNREFUSED / "model not loaded" | `426d1fa` | Pattern-match the error message. |
| `compress.ts` catch block routes `LlmUnavailable` to `{success: true, skipped: true, reason: "llm_unavailable"}` | `426d1fa` | Engine acks the message, no DLQ. The next enqueue pass picks it up. |

The 5-min Ollama unload is no longer pinned by a 24h
`OLLAMA_KEEP_ALIVE` env var (commit `0b43c4c`). When the queue
is idle, the model unloads and the next request triggers a
30-60s cold load that the queue absorbs.

## Phase 6 — Documentation and tooling

| What | Commit |
|---|---|
| `docs/architecture.md` — single-page architecture overview | `8ed35b0` + `acd77cd` + `5d195b6` |
| `docs/IMPROVEMENTS.md` — this file (rewritten for clarity) | (this commit) |
| `docs/final_purpose.md` — status against 7/2 design goals | `b07b0f4` |
| `docs/known-issues.md` — current open problems with root cause / fix / status | `bed9d20` |
| `scripts/status.sh` — one-shot system state | `6333b2e` |
| `scripts/health.sh` — fast status, bypasses `/sessions` | `a512c2f` |
| `scripts/trace-obs.sh` — follow one observation through the pipeline | `a512c2f` |
| `scripts/drain-dlq.py` — DLQ snapshot + discard (Phase 1) | `e769842` + `735b4f0` |

## Branch state

| Branch | Status |
|---|---|
| `feat/omp-adaptation` (at origin) | 16 commits ahead of `main`, all pushed |

## Time spent

- Phase 1 + 1.5: 30 min code + 5 min drain
- Phase 2: ~2 hours (rerank fix + GT rewrite + expansion wire + grid search)
- Phase 3: ~1 hour (prompts + provider)
- Phase 4: ~3 hours (13 OMP/config/test fixes)
- Phase 5: ~30 min (queue hold + keep_alive removal)
- Phase 6: ~2 hours (rewrites + diagnostic tools)
- Issue management: 1 hour
- Total: ~10 hours over 4 days

## What would close the remaining gap

From `docs/known-issues.md`, in order of likely impact:

1. **Re-compress 2460 obs with the Phase 3 prompt** (~10h
   background).
2. **Expand ground truth to 30-50 queries** so the eval signal
   stabilizes.
3. **Try a larger embedding model** (e.g. `bge-large-en-v1.5`
   1024d) — requires a reindex.

The first item is purely background; the other two need human
work. None are blockers for live use.

## How to run things

```bash
# Status (the first thing to run when something looks wrong)
bash scripts/status.sh          # daemon, queue, observations, recent log
bash scripts/health.sh          # fast, bypasses /sessions endpoint

# Trace one observation
bash scripts/trace-obs.sh <sid> <oid>

# Run the retrieval quality benchmark
cd /home/duguex/memory/agentmemory
npx tsx benchmark/backfill-quality-eval.ts

# Drain the DLQ
python3 scripts/drain-dlq.py

# Manually trigger a single obs through the compress queue
curl -X POST http://localhost:3111/agentmemory/compress \
  -H "Authorization: Bearer omp-memory-local" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<sid>","observationId":"<oid>"}'

# Inspect the queue
/home/duguex/.agentmemory/bin/iii trigger --function-id engine::queue::topic_stats --payload '{"topic":"mem::compress"}'
/home/duguex/.agentmemory/bin/iii trigger --function-id engine::queue::dlq_messages --payload '{"topic":"mem::compress","limit":10}'

# Restart the daemon cleanly
pkill -9 -f "node.*agentmemory" 2>/dev/null
rm -f ~/.agentmemory/worker.pid ~/.agentmemory/iii.pid
nohup agentmemory > /tmp/daemon.log 2>&1 &
```
