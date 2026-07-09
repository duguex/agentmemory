# agentmemory Architecture

> What the system is, in one diagram.

## The whole thing

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI coding agent                              │
│  (Claude Code, OMP/Pi, Codex, OpenCode)                        │
│                                                                 │
│  On every tool call: fire a hook script                         │
│  → POST http://localhost:3111/agentmemory/observe              │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              iii-engine  (single binary, port 49134 + 3111)     │
│                                                                 │
│  - Owns the HTTP port 3111                                     │
│  - Routes HTTP requests to registered functions               │
│  - Owns the queue (mem::compress, mem::graph-extract)           │
│  - Owns the KV store (SQLite, ~/.agentmemory/data/)             │
└────────────────────────┬────────────────────────────────────────┘
                         │ in-process
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│          agentmemory daemon  (Node.js process)                 │
│                                                                 │
│  - 270 mem::*/api::*/event::* functions                        │
│  - Each is just a (payload) => Promise<result> handler         │
│  - mem::compress is the main one (see below)                   │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP /v1/chat/completions
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Ollama  (separate process)                  │
│                                                                 │
│  - Owns the GPU (V100 32GB)                                    │
│  - Hosts qwen3.6:35b (22GB VRAM) for mem::compress             │
│  - Hosts nomic-embed-text (0.3GB VRAM) for mem::embed          │
│  - Unloads models after 5min of no requests (Ollama default)   │
└─────────────────────────────────────────────────────────────────┘
```

**Four processes. That's the entire system.**

| Process | Started by | Owns |
|---|---|---|
| **agent** | (user) | (just calls hook scripts) |
| **iii-engine** | agentmemory daemon (spawns) | HTTP 3111, queue, KV |
| **agentmemory daemon** | `nohup agentmemory` (manual) | 270 functions |
| **Ollama** | (system service) | GPU + LLM models |

## Where observations come from

There are **two paths** into agentmemory, both ending in the same
`mem::compress` LLM call.

### Path A: live tool calls (real-time)

The agent is running. Every tool call is captured by a hook.

```
[see "The one flow that matters: tool call → observation" below]
```

This produces a steady stream of observations as the agent works.

### Path B: chat history backfill (one-shot)

The agent's past chat history lives in some export format (JSONL,
JSON dump, sqlite). It's not in agentmemory yet. We import it
once so the backfill sessions have their observations.

```
1.  OMP/Pi chat history → some file format
    (e.g. ~/.claude/history.jsonl, ~/.omp/sessions/*.json)
2.  scripts/backfill-sessions.py (or similar)
    reads the file
    converts each message to a tool-call-shaped JSON:
        {
          "hookType": "post_tool_use",
          "sessionId": "backfill-<uuid>",
          "project": <extracted>,
          "cwd": <extracted>,
          "timestamp": <extracted>,
          "data": {
            "tool_name": <extracted from message>,
            "tool_input": <extracted from message>,
            "tool_output": <extracted from message>,
            "user_prompt": <user message if any>,
          },
        }
3.  For each message, POST /agentmemory/observe
    (same endpoint as live tool calls — the daemon doesn't care)
4.  iii-engine → mem::observe (same handler)
5.  Each obs is enqueued onto mem::compress
6.  The 2460 backfill obs drain through the queue at ~4 obs/min
    (one LLM call per obs, qwen3.6:35b on V100 32GB → ~5s/obs)
7.  After ~10 hours of background draining, the backfill observations
    are fully LLM-compressed and indistinguishable from live observations.
```

**The backfill pipeline reuses the live pipeline.** It's not a
separate "bulk import" path. The difference is only at the source:
live agent calls vs. an off-line script feeding the same
`/observe` endpoint.

After backfill completes, the script also writes a summary via
`/agentmemory/summarize` (per-session) and entities via
`/agentmemory/graph-extract` (per-session). Those run as
`mem::summarize` and `mem::graph-extract` queue jobs, concurrency
2 each, ~1-2 min per session.

### What's NOT in agentmemory

- The user's plain chat text (user prompts, no tool call)
  — these get bundled into the obs that DOES get compressed
    (the `user_prompt` field on a tool call's obs)
- The LLM's plain text replies
  — same: bundled into the obs when the agent uses a tool
- Multi-turn reasoning between tool calls
  — currently lost. The obs is per-tool-call, not per-turn.
    If you want per-turn observations, that needs a new pipeline.

## The one flow that matters: tool call → observation

```
1.  Claude runs a tool (e.g. Bash "ls /tmp")
2.  Claude's PostToolUse hook fires
3.  plugin/scripts/post-tool-use.mjs
    reads JSON from stdin, makes a POST to /agentmemory/observe
4.  iii-engine receives the HTTP request
5.  iii-engine invokes the registered function:  mem::observe
6.  mem::observe (in the daemon) does:
      a. privacy filter (strip secrets)
      b. SHA-256 dedup (skip if seen in last 5 minutes)
      c. kv.set (synthetic placeholder obs)
      d. enqueue mem::compress (background LLM work)
7.  iii-engine returns 200 to the hook immediately.
    The hook process exits. Claude is unblocked.
8.  Meanwhile, in the background:
    iii-engine picks the enqueued job from the queue
    and invokes the mem::compress function on the daemon.
9.  mem::compress (in the daemon) does:
      a. read the synthetic obs from KV
      b. if obs missing → silently ack (orphan skip)
      c. if obs already LLM-compressed → silently ack (skip)
      d. call Ollama: POST /v1/chat/completions
         with the obs text + a prompt asking for XML compression
      e. parse the XML response
      f. kv.delete + kv.set (schema-lock workaround)
      g. re-index into BM25 + vector indices
10. The observation is now stored in agentmemory, retrievable.
```

**Key property**: step 10 happens entirely off the critical path
of the agent's tool call. Step 4 returns 200 in milliseconds; the
LLM work in step 9 takes seconds and runs in the background.

## The other flow that matters: query → context

```
1.  Agent's "before_agent_start" hook fires
2.  plugin/script makes POST /agentmemory/smart-search
    with {query: "what was the VASP binary cleanup workflow?"}
3.  iii-engine invokes mem::smart-search
4.  mem::smart-search does:
      a. (optional) trigger mem::expand-query
         → LLM generates 3-5 reformulations of the query
         → 200ms budget, fallback to plain query on miss
      b. HybridSearch.searchWithExpansion(query, limit, expansion)
         - For each reformulation, run tripleStreamSearch:
           * BM25 (lexical match on title/narrative/concepts)
           * Vector (cosine similarity on 768d embeddings)
           * Graph (entity-based retrieval)
         - Merge results via RRF (k=60, weights bm25:0.4, vector:0.6)
         - Diversify (max 3 obs per session)
         - Rerank top-20 with ms-marco-MiniLM cross-encoder
         - Truncate to limit
      c. (optional) recallLessons (separate LLM call)
5.  Return top-K observations to the agent's system prompt
```

## What's in agentmemory right now

- 94 backfill sessions (from OMP/Pi chat history)
- 2460 total observations
- 100% LLM-compressed (every obs has been through the LLM)
- 0 unknown, 0 synthetic
- Format: each obs has `title`, `narrative`, `type`, `importance`,
  `concepts`, `files`, `compressionKind: "llm"`

## What's in the queues right now

| Queue | What it does | Concurrency |
|---|---|---|
| `mem::compress` | LLM-compress synthetic obs | 1 |
| `mem::graph-extract` | Extract entities + relationships | 2 |
| `agentmemory.session.started` / `.ended` | Pub/sub events | n/a |

`mem::compress` is the busy one. Each call:
- reads 1 obs from KV
- calls Ollama (qwen3.6:35b)
- writes 1 compressed obs back to KV
- ~4-6 seconds per call on V100 32GB

### Concurrency and scheduling

The `mem::compress` queue runs at **concurrency=1** (one obs at a
time). At ~5s/obs this means **~12 obs/min peak throughput**, but
typical real-world rate is ~4 obs/min once you factor in
`mem::graph-extract` competing for the same Ollama instance.

The queue has these retry parameters (in `iii-config.yaml`):
```
max_retries: 1        # one retry on transient error
backoff_ms: 2000      # 2s between retries
message_group_field: observationId   # FIFO per-obs ordering
```

### Per-obs vs batch LLM calls

`mem::compress` issues **one LLM call per observation**. Each
call is `POST /v1/chat/completions` with a single obs's text in
the user prompt and a request for one `<observation>` XML
response. The 5s/obs cost is dominated by:

- 30-60s cold load on the first request after Ollama unloads
  the model (amortized to ~0s over many obs)
- ~3-5s inference per obs on V100 32GB with 22GB qwen3.6:35b
- ~1s of orchestration overhead (KV read/write, BM25 + vector
  re-index)

This is the right call for **correctness** — every obs is a
self-contained LLM transaction, parse failure on one obs
doesn't affect the others, and the FIFO ordering per
observationId is preserved. It's the wrong call for
**throughput** — see "Open issue #1" below.

A batch mode would buffer N obs and send one chat completion
with all N in the user prompt, parsing N `<observation>`
responses out of the result. Trade-off: larger prompts → more
VRAM, but one cold-load amortizes across N obs. This is a
known design alternative, not implemented. See
`docs/known-issues.md` #1.

### Queue hold: "LLM is unavailable" vs "request is broken"

When the Ollama endpoint returns an error, `mem::compress` has to
decide: is this a "the LLM is briefly down, hold this obs and try
again later" error, or a "this request is malformed, it's not
going to work" error?

- **LLM unavailable** (Ollama model unloaded, ECONNREFUSED,
  "model not found"): returns `{success: true, skipped: true,
  reason: "llm_unavailable"}` — the engine acks the message
  without retrying, and the obs is implicitly held for the next
  enqueue pass.
- **Real error** (parse fail, malformed XML, 5xx that isn't a
  transient): returns `{success: false}` — the engine retries 1x,
  then DLQs the message.

The LLM-unavailable detection lives in
`OpenAIProvider.isLlmUnavailable()` in `src/providers/openai.ts`
and is called from the catch block in `src/functions/compress.ts`.

### Circuit breaker

The LLM provider wraps every call with a circuit breaker
(`src/providers/circuit-breaker.ts`):
- After 3 failures within a 60s window → circuit opens
- Circuit stays open for 30s
- After 30s → one probe call (half-open state)
- If probe succeeds → circuit closes, normal traffic resumes
- If probe fails → circuit re-opens for another 30s

This prevents a string of failures from hammering a sick Ollama
endpoint. The 30s open period is short enough that a transient
outage self-heals quickly.

### Deduplication

`mem::observe` dedups incoming obs by SHA-256 fingerprint of the
event, with a **5-minute window**. If a tool call's event
fingerprint was seen in the last 5 minutes, the new one is
silently dropped. This prevents a buggy or chatty hook from
flooding the corpus with the same obs.

The 5-minute window is hard-coded in `src/functions/observe.ts`.
Longer windows (e.g. across a full agent session) would dedup
more aggressively but risk dropping legitimate retries of
distinct-but-similar events.

### Ollama model unload

Ollama's default behavior: unload a model from VRAM after 5
minutes of no requests. The `qwen3.6:35b` model is 22GB, so this
matters — leaving it loaded permanently would block other GPU
work.

**However**: as long as `mem::compress` is consuming from the
queue (which it is, at ~4 obs/min), the model never idles and
Ollama never unloads it. The 5-min unload only kicks in if the
queue is empty for 5+ minutes — a deliberate idle. See
`docs/known-issues.md` for the implications.

We do **not** set `OLLAMA_KEEP_ALIVE` on the daemon. That env
var was removed in commit `0b43c4c` because pinning the model
permanently is the wrong trade-off: it gives faster per-obs
latency at the cost of 22GB VRAM always reserved. The queue is
designed to absorb the 30-60s cold-load latency on the first
request after idle.

## What's in storage

```
~/.agentmemory/
├── .env                     # OPENAI_BASE_URL=http://localhost:11434/v1
│                            # OPENAI_MODEL=qwen3.6:35b-a3b-mtp-q4_K_M
│                            # OPENAI_API_KEY=ollama
│                            # AGENTMEMORY_SECRET=omp-memory-local
│                            # AGENTMEMORY_AUTO_COMPRESS=true
│                            # (NO OLLAMA_KEEP_ALIVE — Ollama default 5min)
│
├── worker.pid               # daemon pid
├── iii.pid                  # engine pid
│
└── data/
    ├── state_store.db/      # SQLite-backed KV (one file per scope)
    │   ├── mem%3Aobservations%3A<sid>.bin   # one file per session's observations
    │   ├── mem%3Asessions.bin              # session list
    │   ├── mem%3Asummaries%3A<sid>.bin    # per-session summary
    │   ├── mem%3Aindex%3Abm25:...bin       # BM25 index
    │   ├── mem%3Aindex%3Avectors:...bin    # vector index
    │   ├── mem%3Agraph%3A...               # graph nodes/edges
    │   └── ...
    │
    ├── queue_store/         # file-based queue (managed by iii-engine)
    │   └── _queue_lists.bin
    │
    └── stream_store/        # pub/sub streams
```

## Components summary

| Component | What | Where |
|---|---|---|
| **Hooks** | Capture tool calls from the agent | `src/hooks/*.ts` (bundled into plugins) |
| **REST API** | `POST /observe`, `GET /smart-search`, ... | `src/triggers/api.ts` |
| **mem::observe** | dedup + privacy + enqueue compress | `src/functions/observe.ts` |
| **mem::compress** | the LLM compression handler | `src/functions/compress.ts` |
| **Queue** | built-in iii-queue, file-based | `iii-config.yaml` |
| **StateKV** | per-scope SQLite | `src/state/kv.ts` |
| **Vector index** | nomic-embed-text 768d | `src/state/vector-index.ts` |
| **BM25 index** | per-shard inverted index | `src/state/search-index.ts` |
| **HybridSearch** | BM25 + vector + graph + rerank fusion | `src/state/hybrid-search.ts` |
| **Reranker** | cross-encoder (ms-marco-MiniLM) | `src/state/reranker.ts` |
| **LLM provider** | OpenAI-compatible → Ollama | `src/providers/openai.ts` |
| **Query expansion** | LLM reformulations (optional) | `src/functions/query-expansion.ts` |
| **Graph extraction** | entities + relationships | `src/functions/graph-extract.ts` |
| **OMP integration** | OMP/Pi agent ↔ agentmemory bridge | `integrations/omp/index.ts` |
| **Status / diagnostics** | one-shot system state | `scripts/status.sh`, `scripts/health.sh` |
| **Trace a single obs** | follow one record through | `scripts/trace-obs.sh` |

## What's NOT in scope (deliberate omissions)

Things agentmemory does not do, by design:

- **Multi-turn reasoning between tool calls** is not stored. Each
  observation is per-tool-call. The LLM's plain text replies are
  bundled into the obs that triggered the tool, not captured
  separately.
- **Cross-session user identity** is not enforced. Sessions are
  identified by `sessionId` (string), no auth. The bearer token
  in `AGENTMEMORY_SECRET` is the only access control.
- **Real-time event streaming** to the agent. The agent sees
  observations only when it queries via `/smart-search`; there's
  no push channel that fires when a related obs lands.
- **Observation editing / deletion API** for end users. The agent
  can observe and search, but there's no `DELETE /observations`
  endpoint. Removal is done by editing the SQLite directly
  (see `scripts/drain-dlq.py` for an example).
- **Batch LLM calls** for compression. Each obs is one LLM
  call. See `docs/known-issues.md` for why this is a known
  performance limitation.

## How to interact with it

```bash
# See system state
bash scripts/status.sh          # daemon, queue, observations, recent log
bash scripts/health.sh          # same but bypasses /sessions endpoint

# Trace one observation
bash scripts/trace-obs.sh <sid> <oid>

# Run the retrieval quality benchmark
npx tsx benchmark/backfill-quality-eval.ts
```

## Known limitations and gotchas

These aren't bugs — they're design constraints you'll hit.

- **`/agentmemory/sessions` is slow on 100+ sessions.** The
  handler reads the full session list from KV, fetches per-session
  summaries, and returns them all. On the current 134-session
  corpus it can take >10s. Use `scripts/health.sh` for fast
  status; reserve the `/sessions` endpoint for explicit
  browsing.
- **The first LLM request after idle is slow (30-60s).** Ollama
  has to load qwen3.6:35b from disk into 22GB of VRAM. The
  queue absorbs this latency — no obs is lost, they just wait
  in the queue. This is the trade-off for not pinning the model
  permanently.
- **Daemon restart can leave orphan workers.** After a daemon
  crash + restart, the engine sometimes retains the old worker
  registration alongside the new one. The `/health` endpoint
  will show `workers: 2` instead of `workers: 1`. The fix is to
  kill any `node.*agentmemory` process before restart.
- **Per-obs LLM call is the throughput bottleneck.** qwen3.6:35b
  on V100 32GB takes ~5s per obs. With concurrency=1 the
  ceiling is ~12 obs/min but real-world is ~4. This is a
  single-GPU hardware limit, not a software bug.
- **Three commits made 24h keep_alive obsolete** (commits
  `e769842`, `ced858e`, `0b43c4c`). If you see the daemon started
  with `nohup env OLLAMA_KEEP_ALIVE=24h agentmemory`, that command
  line is stale; the modern equivalent is just `nohup agentmemory`.

For more open issues and their current state, see
`docs/known-issues.md` and the GitHub issue tracker.

## See also

- `docs/IMPROVEMENTS.md` — change history and what was fixed
- `AGENTS.md` — coding conventions
- `CLAUDE.md` — quick reference
