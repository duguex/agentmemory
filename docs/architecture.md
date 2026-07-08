# agentmemory Architecture

> Single-page overview of how the system fits together. Updated 2026-07-09.

## Process layout

```
┌─────────────────────┐   WS    ┌─────────────────────┐
│  OMP / Claude /     │ ──────▶ │  iii-engine         │
│  Codex / OpenCode   │         │  (port 49134)       │
│  hook scripts       │         │  + HTTP 3111        │
└─────────────────────┘         └─────────┬───────────┘
                                          │ WS register
                                          ▼
┌─────────────────────────────────────────────────────────┐
│  agentmemory daemon  (single Node.js process)           │
│  src/index.ts                                          │
│                                                         │
│  - registerWorker (270 functions)                       │
│  - registerTrigger  (HTTP + event + queue)              │
│  - HybridSearch    (BM25 + vector + graph + rerank)     │
│  - MetricsStore    (KV-backed, persists across restart) │
└─────────────────────────────────────────────────────────┘
```

The daemon is a **single Node process** that:
1. Spawns the `iii` binary (or uses an existing one) — it owns port 3111 (HTTP) and 3112 (WebSocket streams).
2. Registers 270 mem::*/api::*/event::* functions with the engine via WebSocket.
3. Owns a StateKV (SQLite at `~/.agentmemory/data/state_store.db`).
4. Owns a queue store (file-based, at `~/.agentmemory/data/queue_store`).
5. Owns a vector index (binary files at `~/.agentmemory/data/state_store.db` directory).

## Booting

```
$ agentmemory                                  # the CLI
  └─ spawns /home/duguex/.agentmemory/bin/iii --config iii-config.yaml
  └─ waits for iii-engine to be ready (port 49134)
  └─ registers worker via WS
  └─ registers HTTP triggers
  └─ logs the function_count (e.g. "Worker registered with ID: ...")
  └─ the banner shows REST API on 3111, Viewer on 3113, Streams on 3112
```

The boot log stops at the banner when all functions are registered. If HTTP requests return 404, **the boot did not finish** (look for thrown errors in stderr).

## Data flow: one tool call → one observation

```
Claude PostToolUse
  └─ plugin/scripts/post-tool-use.mjs  (Node, exits in ~500ms)
      └─ POST /agentmemory/observe  with {hookType, sessionId, project, ...}
          └─ iii HTTP trigger  →  api::observe handler
              └─ sdk.trigger  mem::observe
                  └─ src/functions/observe.ts
                      ├─ privacy filter (strip secrets)
                      ├─ SHA-256 dedup window (5 min)
                      ├─ kv.set(observations(sessionId), obsId, obs)
                      ├─ sdk.trigger  mem::embed  (vector index update)
                      └─ sdk.trigger  mem::compress  (LLM compression, queue)
                          └─ iii-queue mem::compress (concurrency=1, FIFO group=observationId)
                              └─ src/functions/compress.ts
                                  ├─ read raw from KV (drain time, may be missing → orphan-ack)
                                  ├─ already-LLM? → skip
                                  ├─ call Ollama /v1/chat/completions
                                  ├─ validate output (XML parse)
                                  ├─ kv.delete + kv.set (schema-lock workaround)
                                  ├─ BM25 + vector re-index
                                  └─ 2× stream::set (per-session + viewer group)
```

## Retrieval flow: one smart-search call

```
POST /agentmemory/smart-search  {query, limit}
  └─ iii HTTP trigger  →  api::smart-search
      └─ sdk.trigger  mem::smart-search
          └─ src/functions/smart-search.ts
              ├─ (Phase 2.3) sdk.trigger  mem::expand-query  (200ms budget)
              │   └─ src/functions/query-expansion.ts
              │       └─ LLM generates reformulations + entity hints
              │       └─ parse XML → QueryExpansion
              ├─ searchFn(query, limit, {expansion})
              │   └─ src/state/hybrid-search.ts  HybridSearch.searchWithExpansion
              │       └─ tripleStreamSearch per reformulation
              │           ├─ BM25  (src/state/search-index.ts)
              │           ├─ Vector (src/state/vector-index.ts)
              │           └─ Graph  (src/functions/graph-retrieval.ts)
              │       └─ merge via RRF (k=60, weights bm25:0.4 / vector:0.6 / graph:0.3)
              │       └─ diversifyBySession (max 3 per session)
              │       └─ enrichResults (KV lookup)
              │       └─ rerank (Phase 2.1: cross-encoder pair API, parallel, 250ms/timeout)
              │           └─ @xenova/transformers ms-marco-MiniLM-L-6-v2
              │           └─ 70/30 blend with original combinedScore
              └─ recallLessons (if includeLessons=true)
              └─ recordAccessBatch (for followup-rate diagnostic)
```

## Key queues

| Queue | concurrency | retries | backoff | group_field | Purpose |
|---|---|---|---|---|---|
| `mem::compress` | 1 | 1 | 2000ms | observationId | LLM compress raw obs |
| `mem::graph-extract` | 2 | 3 | 1000ms | sessionId | Extract entities + relationships |
| `agentmemory.session.started` / `agentmemory.session.ended` | n/a | n/a | n/a | n/a | Pub/sub events |

**Why concurrency=1 for mem::compress**:
- qwen3.6:35b is 24GB on V100 32GB. Two parallel inferences fight for VRAM.
- concurrency=1 hits 4 obs/min; concurrency=2 hit 3 obs/min (slower per-obs).

**Why observationId is the FIFO group field**:
- The drain-time handler reads from KV by observationId. Reordering by group means a stale obs never gets LLM-compressed before its in-flight sibling.
- Trade-off: orphans can stall their group until ack. Phase 1.1 fix made orphans silent-ack to avoid this.

## KV scopes

Defined in `src/state/schema.ts`. Fixed at startup; runtime rejects unknown scopes.

| Scope | Contents | Size |
|---|---|---|
| `mem:observations:<sessionId>` | map<obsId, CompressedObservation> | the corpus |
| `mem:sessions` | Session[] | session metadata |
| `mem:metrics:<functionId>` | FunctionMetrics | success/failure counts |
| `mem:search-index:bm25` | BM25 inverted index | terms → docIds |
| `mem:index:bm25:idx_<id>:<shard>` | vector shards | 768d embeddings |
| `mem:health` | last health snapshot | ephemeral |
| `mem:graph:nodes` / `mem:graph:edges` | graph index | entity + relationships |
| `mem:access:obs:<obsId>` | last access time | followup-rate diagnostic |

## Key files

| Path | What |
|---|---|
| `src/index.ts` | Worker bootstrap, register all 270 functions |
| `src/functions/compress.ts` | LLM compress handler (most-trafficked) |
| `src/functions/observe.ts` | Hook ingest handler |
| `src/functions/smart-search.ts` | Retrieval entry point |
| `src/state/hybrid-search.ts` | BM25 + vector + graph + rerank fusion |
| `src/state/reranker.ts` | Cross-encoder rerank (Phase 2.1 fix) |
| `src/state/vector-index.ts` | Vector ANN search |
| `src/state/search-index.ts` | BM25 inverted index |
| `src/state/kv.ts` | SQLite adapter |
| `src/state/schema.ts` | KV scopes, CompressedObservation type |
| `src/providers/openai.ts` | OpenAI-compatible provider (used for Ollama) |
| `src/providers/circuit-breaker.ts` | Per-provider failure gating |
| `src/prompts/*.ts` | LLM prompt templates |
| `iii-config.yaml` | Engine config (queue, observability, ports) |
| `benchmark/backfill-quality-eval.ts` | Retrieval quality measurement |
| `scripts/upgrade-backfill-compression.py` | Drain queue + ensure LLM coverage |
| `scripts/drain-dlq.py` | Snapshot + discard DLQ entries (Phase 1.3) |
| `scripts/status.sh` | One-glance system health (this phase) |

## State directory

```
~/.agentmemory/
├── .env                     # provider config (Ollama URL, model, secret)
├── worker.pid               # current daemon pid
├── iii.pid                  # current engine pid
├── engine-state.json        # last known engine state
├── preferences.json         # user prefs
├── data/
│   ├── state_store.db/      # SQLite KV (one file per scope)
│   ├── queue_store/         # file-based queue store
│   └── stream_store/        # pub/sub streams
├── dlq-snapshots/           # audit trail of cleared DLQ entries
└── images/                  # vision-obs blobs
```

## Health endpoints

| Endpoint | Returns |
|---|---|
| `GET /agentmemory/health` | daemon status, circuit breaker state, function metrics, workers, event-loop lag, memory, uptime |
| `GET /agentmemory/sessions?limit=200` | session list |
| `GET /agentmemory/observations?sessionId=...` | obs list per session |
| `POST /agentmemory/smart-search` | the actual retrieval path |
| `POST /agentmemory/compress` | enqueue a single obs for re-compression |

Engine-internal (run via `iii trigger`):
- `engine::queue::topic_stats` — depth + dlq_depth per topic
- `engine::queue::dlq_messages` — peek DLQ contents
- `engine::functions::list` — registered functions

## Scripts

| Script | Purpose |
|---|---|
| `scripts/status.sh` | One-shot system state (daemon, queue, corpus, metrics) |
| `scripts/upgrade-backfill-compression.py` | Background daemon to enqueue synthetic obs for LLM upgrade |
| `scripts/drain-dlq.py` | Snapshot + clear DLQ entries |
| `benchmark/backfill-quality-eval.ts` | Retrieval quality measurement (R@K, P@K, MRR, NDCG, HitRate) |
| `benchmark/tune-weights.sh` | Grid search for HybridSearch weight tuning |

## See also

- `docs/IMPROVEMENTS.md` — Phase 1-4 progress, current state
- `docs/reviews/` — prior code reviews
- `docs/issues/` — local issue tracking
- `AGENTS.md` — coding conventions
- `CLAUDE.md` — quick reference for Claude Code sessions
- `benchmark/QUALITY.md` — historical retrieval quality numbers (mostly stale, see #62)
