# Final Purpose

> Status against the original 7/2 design goals, as of 2026-07-10.

## Original goals (set 2026-07-02)

1. **Process OMP/Oh-My-Pi chat history into high-quality memories**
   that are retrievable and usable for context injection.
2. **Adapt to different coding agents.**

## Original technical approach

1. **Unify** the chat history and live-session processing pipelines
   so the backfill reuses the live path as much as possible.
2. **Use a queue** to handle high LLM volume, accepting high LLM
   usage to pursue memory quality.

## Status today

| # | Goal | Status | Evidence |
|---|---|---|---|
| 1 | High-quality retrievable memories | **Mostly met, retrieval quality mediocre** | 2460 backfill obs, 100% LLM-compressed. Eval R@10=29.6%, MRR=0.224 on 16 hand-labeled queries. Best queries hit 100% (VASP binary cleanup, find large files). |
| 2 | Adapt to different agents | **Partially met** | OMP integration is fully wired. Claude/Codex/OpenCode hooks exist but were not exercised during the test cycle. |
| T1 | Unified backfill + live pipeline | **Met** | `scripts/backfill-sessions.py` reuses the `/observe` endpoint. The LLM call is the same `mem::compress` handler. See `docs/architecture.md` for the two-path diagram. |
| T2 | Queue for high LLM volume | **Met, with a known limitation** | The `mem::compress` queue absorbs latency, retries, and now LLM-unavailability (commit `426d1fa`). However, **per-obs LLM call** is the throughput ceiling — see "Known limitations" below. |

## Known limitations affecting these goals

These are not blockers but are worth knowing before claiming
"the goal is met":

- **Retrieval quality (R@10=29.6%) is below typical production
  targets (≥50%)**. Root causes: the GT is sparse (16 queries,
  5 categories), the embedding model is generic (nomic-embed
  768d), and ~2460 obs was processed with the old prompt.
  Re-compressing with the Phase 3 prompt (commit `8756a5b`)
  is the highest-leverage remaining work.
- **No batch LLM calls**. Each obs is its own LLM call, which is
  the right call for correctness but the wrong call for
  throughput. With 1 obs = 1 call and ~5s/obs, the queue can
  drain ~12 obs/min peak. A batch mode would let one cold-load
  process N obs in a single inference.
- **24GB VRAM permanently reserved while the daemon is running**.
  Ollama's 5-min unload only kicks in if the queue is empty for
  5+ minutes. This is by design (commit `0b43c4c`), but it's
  worth knowing if you share the GPU with other workloads.

## What would close the gap

If you want R@10 ≥ 50% and don't want to keep iterating:

1. **Re-compress 2460 obs with the Phase 3 prompt** (~10 hours
   background). Run `scripts/upgrade-backfill-compression.py`.
2. **Expand the GT to 30-50 queries** so the eval signal
   stabilizes. 16 is too few.
3. **Try a larger embedding model** (e.g. `bge-large-en-v1.5`
   1024d). Reindex is a separate commit.

If you only care about *the corpus being there* and the search
quality is good enough for context injection, the system is
already usable as-is. Run `bash scripts/status.sh` to confirm
the daemon is healthy.

## See also

- `docs/architecture.md` — current architecture
- `docs/IMPROVEMENTS.md` — change history
- `docs/known-issues.md` — current open problems
- `benchmark/backfill-quality-eval.ts` — run the retrieval eval
