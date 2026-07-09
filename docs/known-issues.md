# Known Issues

> Current open problems as of 2026-07-10. Severity, root cause,
> and what would fix it.

## Open

### 1. Per-obs LLM call is the throughput ceiling

- **Symptom**: `mem::compress` processes ~4 obs/min in practice
  (peak ~12 obs/min). On a 2460-obs backfill that's ~10 hours
  of single-threaded drain.
- **Root cause**: `mem::compress` handler issues one
  `POST /v1/chat/completions` per observation. Each call is
  ~5s on V100 32GB. Concurrency=1 (set deliberately to avoid
  GPU contention on the 24GB qwen3.6:35b model) caps parallelism.
- **Severity**: medium. The corpus is fully drained so this
  doesn't block live use, but a fresh re-compress or a different
  corpus would re-trigger it.
- **Fix** (not implemented): batch mode. Buffer N obs in
  memory, send one chat completion with all N obs in the user
  prompt, parse N XML responses out of the result. Trade-off:
  larger prompts → more VRAM, but a single cold-load amortizes
  across N obs.
- **Status**: known, no in-flight work.

### 2. 24GB VRAM permanently reserved while daemon is running

- **Symptom**: `qwen3.6:35b` (22GB) stays in VRAM as long as
  the daemon is alive and the queue is non-empty.
- **Root cause**: Ollama unloads a model after 5 minutes of no
  requests. As long as `mem::compress` is consuming from the
  queue at any rate, the model never idles and never unloads.
  In our setup the queue is rarely empty, so unload rarely
  happens.
- **Severity**: high if the GPU is shared with other workloads;
  low if dedicated.
- **Fix** (not implemented): batch mode (item #1) would
  naturally produce idle periods between batches, allowing
  Ollama to unload. Alternatively, an explicit
  `OLLAMA_KEEP_ALIVE=2m` (short, not 24h) could be set —
  shorter than the queue empty-period and shorter than any
  realistic agent pause. Commit `0b43c4c` removed the 24h
  variant; the trade-off discussion is in
  `docs/IMPROVEMENTS.md`.
- **Status**: known, requires the batch-mode fix or a
  policy decision about acceptable VRAM reservation.

### 3. Retrieval quality (R@10 = 29.6%) below typical targets

- **Symptom**: 16-query benchmark reports R@10=29.6%, MRR=0.224.
  Best queries (VASP binary cleanup, find large files) hit
  100%, but the average is dragged down by queries with sparse
  ground truth.
- **Root cause**: probably a mix of (a) generic embedding model
  (nomic-embed 768d, no fine-tuning), (b) the corpus was
  processed with the old prompt before commit `8756a5b`, (c)
  ground truth is sparse — only 16 hand-labeled queries.
- **Severity**: medium. Search is usable for the specific
  queries it scores well on; quality on the long tail is
  unknown.
- **Fix** (not implemented): three changes worth trying, in
  order of likely impact:
  1. Re-compress 2460 obs with the Phase 3 prompt via
     `scripts/upgrade-backfill-compression.py` (~10h
     background)
  2. Expand ground truth to 30-50 queries covering more
     session types
  3. Try a larger embedding model (`bge-large-en-v1.5`
     1024d) — reindex is a separate operation
- **Status**: known, in-flight evaluation.

### 4. `/agentmemory/sessions` is slow on 100+ sessions

- **Symptom**: GET `/agentmemory/sessions?limit=5` can take
  >10s when the corpus has 100+ sessions. The handler reads
  the full session list, then fetches a per-session summary
  for each, sequentially.
- **Root cause**: `src/triggers/api.ts` does
  `Promise.all(sessions.map(s => kv.get(summaries, s.id)))`.
  The list-and-fetch is fine for ≤50 sessions but degrades
  linearly beyond that.
- **Severity**: low. Diagnostics tools (`scripts/health.sh`,
  `scripts/trace-obs.sh`) bypass this endpoint.
- **Fix** (not implemented): paginate the response, or cache
  summaries in memory and incrementally refresh.
- **Status**: known, low priority.

### 5. Daemon restart can leave orphan workers

- **Symptom**: after a daemon crash + restart, `/health`
  shows `workers: 2` instead of `workers: 1`. The old worker
  registration on the engine is stale but the engine doesn't
  notice.
- **Root cause**: iii-engine v0.11.2 doesn't expire stale
  workers automatically.
- **Severity**: low. The new worker handles all traffic; the
  old one is just a registered no-op.
- **Fix** (workaround): kill any `node.*agentmemory` process
  before restart. Better fix: upgrade iii-engine to a version
  that expires stale workers.
- **Status**: known, workaround documented.

### 6. DLQ depth can grow if a bad batch enters the queue

- **Symptom**: `dlq_depth` was 0 in 7/8; on 7/9 it had grown
  to 8 again.
- **Root cause**: the DLQ retries 1x with 2s backoff. A small
  burst of bad inputs (e.g. malformed tool output that the LLM
  consistently can't parse) will land in the DLQ at 2s/obs.
  The DLQ is not auto-drained.
- **Severity**: low. DLQ growth is bounded by the rate of bad
  inputs. Use `scripts/drain-dlq.py` to clear.
- **Fix** (not implemented): schedule `drain-dlq.py` as a cron
  to keep the DLQ empty.
- **Status**: known, manual drain available.

### 7. Query expansion adds +40% latency for neutral precision

- **Symptom**: with `mem::expand-query` wired in, the
  benchmark latency jumped from ~570ms to ~1150ms but R@10
  and MRR didn't improve.
- **Root cause**: for the VASP-specific benchmark set, the
  LLM-generated reformulations don't add signal that the
  BM25+vector ranking already captures. The reformulations
  are paying latency cost for zero gain.
- **Severity**: low for the current corpus. Could become
  useful for more diverse or ambiguous queries.
- **Fix** (not implemented): add an env flag
  `AGENTMEMORY_QUERY_EXPANSION=false` to disable in
  latency-sensitive paths. Also: gate expansion on short
  queries (long queries are usually already well-formed).
- **Status**: known, env flag proposed.

## Resolved

- **Rerank input was the wrong shape** (single text instead of
  query+doc pair). Fixed in commit `04e701c` — `reranker.ts`
  now uses `{text, text_pair}` cross-encoder API.
- **Orphan obs landed in DLQ after 30s of retries**. Fixed in
  commit `e769842` — `compress.ts` now silently acks when the
  obs is missing from KV.
- **24h `OLLAMA_KEEP_ALIVE` was a workaround**. Removed in
  commit `0b43c4c`; the queue is designed to absorb the 30-60s
  cold-load.
- **ServerOk in OMP was a sticky latch**. Fixed in commit
  `a8a5a99` — replaced with `ensureServerOk()` TTL-cached probe.
- **DLQ pagination was broken**. Fixed in commit `735b4f0` —
  `drain-dlq.py` re-pages from offset 0 with dedup.

## See also

- `docs/architecture.md` — how it all fits together
- `docs/IMPROVEMENTS.md` — full change history
- GitHub issues — concrete bug reports with repro steps
