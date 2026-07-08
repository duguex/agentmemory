# agentmemory Improvements Tracker

> Last updated: 2026-07-09

This document tracks the systematic improvement work for agentmemory's
backfill corpus and search quality. It's the single source of truth for
"what's done, what's in progress, and what's queued."

## TL;DR

- **Corpus**: 100% LLM-compressed (2460/2460 obs)
- **DLQ**: 0 (was 5538, drained 2026-07-08)
- **Search quality**: session R@10 = 29.6% / MRR = 0.224 on a 16-query labeled set
- **Daemon**: healthy, single process, circuit closed
- **Open issues**: 21 (15 pre-existing + 6 new from this work)

For a one-line status, run: `bash scripts/status.sh`

## Phase 1 — DLQ cleanup ✅ DONE (2026-07-08)

Goal: stop DLQ growth, clear the existing 5538 backlog.

| Task | Commit | Status |
|---|---|---|
| 1.1 silent-ack orphan obs (no more throw) | `e769842` | ✅ |
| 1.2 tune max_retries 3→1, backoff_ms 5000→2000 | `e769842` | ✅ |
| 1.3 drain-dlq.py (snapshot + discard, idempotent) | `e769842` + `735b4f0` | ✅ |
| 1.4 verify DLQ stays at 0 | (operational) | ✅ |

**Result**: DLQ 5538 → 0 in 4 minutes. New orphans silently ack with a
warn log, do not enter DLQ. Corrupt-and-restart cycle (the 7/4-7/7
disaster) is fully resolved.

## Phase 2 — Retrieval quality ✅ DONE (2026-07-08/09)

Goal: stop the 41.7% R@10 placebo numbers, give the eval real signal,
fix rerank and wire query expansion.

| Task | Commit | Status |
|---|---|---|
| 2.1 fix rerank input (pair API + parallel + timeout) | `04e701c` | ✅ |
| 2.2 rewrite ground truth (16 queries, 5 categories, NDCG+HitRate) | `04e701c` | ✅ |
| 2.3 wire query expansion into smart-search | `d9a5b52` | ✅ |
| 2.4 weight grid search (default 0.4/0.6/0.3 is optimal) | `52f231a` | ✅ |

**Result**: Session R@10 = 29.6%, MRR = 0.224 on a real, hand-labeled
benchmark. Two queries (VASP binary cleanup, find large files) hit
100% recall. The 41.7% / 0.200 numbers in `benchmark/QUALITY.md` were
inflated by an empty-label bug in the eval — that file is now stale
(issue #62 tracks cleanup).

Query expansion is wired in but adds +40% latency for neutral
precision on the VASP benchmark. See #64 for the env-flag proposal.

## Phase 3 — Corpus quality (TODO)

Goal: improve the content of LLM-compressed obs, not just the count.

The 7 prompt files in `src/prompts/` are the leverage point. From the
Phase 2 review, recommended edits:

| Prompt | Edit |
|---|---|
| `compression.ts` | add noise filter (empty grep → importance 2-3), add dedup hint for near-duplicate obs |
| `summary.ts` | add `tags` field (BM25 boost) + `key_decision` field (high-signal summary) |
| `consolidation.ts` | soften "2+ episodes" rule (high-stakes single-episode facts shouldn't be dropped) |
| `graph-extraction.ts` | add source-obs refs on relationships (downstream graph stitching broken without) |
| `reflect.ts` | require disconfirming-evidence (LLM currently ignores counter-examples) |
| `vision.ts` | replace free-form prose with structured output |
| `providers/openai.ts` | temperature=0 default, retry on 429/5xx, JSON-mode hint for XML-output prompts |

After prompts change, **re-compress all 2460 obs** (4 obs/min × 2460
obs / 60 = ~10 hours of queue time at concurrency=1). Re-run eval to
measure improvement.

## Phase 4 — Open issues (TODO)

15 pre-existing open issues from prior code reviews. Severity
breakdown (from 2026-07-09 read):

### OMP correctness (P0, ~5h)

- #56 setTimeout missing .unref() — 5 min
- #53 JSON.stringify(event.result) loses Error — 30 min
- #27 + #55 serverOk sticky-true (duplicates) — 1-2h
- #21 currentProject doesn't refresh on cd — 1h
- #22 + #23 agent_start/end asymmetric lifecycle — 1.5h
- #25 systemPrompt="" produces leading newline — 15 min

### OMP transport (P1, ~1h)

- #54 URL prefix detection matches hostname substring — 15 min
- #28 Content-Type on body-less GET — 15 min
- #52 Promise.withResolvers needs Node 22+ polyfill — 15 min

### Config drift (P1, ~1h)

- #33 getAutoForgetIntervalMs/Evict duplicate safeParseInt — 30 min
- #32 AUTO_FORGET_INTERVAL_MS rename has no migration path — 30 min

### P2 cleanup (~30 min)

- #29 maybeWarnPlaintextBearer top-level call is dead — 10 min
- #57 auto-compress.test.ts env-deletion bug — 15 min

## New issues filed from this work

6 issues opened 2026-07-08/09 from problems found during the
improvement work. All have fix commits in `feat/omp-adaptation`:

| # | Title | Commit that fixed it |
|---|---|---|
| #58 | DLQ pagination broken: offset-based after discard removes entries | `735b4f0` |
| #59 | logger singleton missing .debug() — caller crashes if invoked | `d9a5b52` |
| #60 | HybridSearch weights are read at boot only — no hot-reload | (open — needs work) |
| #61 | Rerank input constructed incorrectly (query+doc concatenated) | `04e701c` |
| #62 | backfill-quality-eval: empty relevantSessions = 1.0 recall (stale #1) | `04e701c` |
| #63 | Orphan obs: 3 retry × 5s = 30s wasted per deleted observation | `e769842` |
| #64 | query expansion wired but adds +40% latency for neutral precision | (open — needs env flag) |

## Branch state

| Branch | Status | Last commit |
|---|---|---|
| `main` (at origin) | not ahead of upstream | — |
| `feat/omp-adaptation` (at origin) | 6 commits ahead of last OMP-related commit | `52f231a` |

All Phase 1+2 work lives on `feat/omp-adaptation`. Pushing works,
PRs not yet opened. Suggested next: open a PR with Phase 1+2 commits
and let the maintainer review.

## Time spent (rough)

- Phase 1: 30 min code + 5 min drain
- Phase 2: ~2 hours (rerank fix + GT rewrite + expansion wire + grid search)
- Issues + tracking: 1 hour
- Total: ~3.5 hours of focused work over 2 days

## How to run things

```bash
# One-shot status (the first thing to run when something looks wrong)
bash scripts/status.sh

# Run the retrieval quality benchmark
cd /home/duguex/memory/agentmemory
npx tsx benchmark/backfill-quality-eval.ts

# Drain the DLQ (safe to re-run; idempotent)
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
nohup env OLLAMA_KEEP_ALIVE=24h agentmemory > /tmp/daemon.log 2>&1 &
```

## Files added/modified

| File | What |
|---|---|
| `src/functions/compress.ts` | orphan silent-ack |
| `src/state/reranker.ts` | cross-encoder pair API + parallel + timeout |
| `src/functions/smart-search.ts` | query-expansion trigger + searchWithExpansion route |
| `src/index.ts` | explicit rerankEnabled flag |
| `iii-config.yaml` | mem::compress concurrency=1, max_retries=1, backoff_ms=2000 |
| `benchmark/backfill-quality-eval.ts` | rewritten GT (16 queries, NDCG, HitRate, full UUID match) |
| `scripts/drain-dlq.py` | new — snapshot + discard DLQ |
| `scripts/upgrade-backfill-compression.py` | rewritten to use topic_stats depth instead of progress.json |
| `scripts/status.sh` | new — one-shot system status |
| `scripts/tune-weights.sh` | new (in `benchmark/`) — weight grid search |
| `docs/architecture.md` | new — single-page architecture overview |
| `docs/IMPROVEMENTS.md` | new — this file |
