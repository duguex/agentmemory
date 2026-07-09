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

## See also

- `docs/IMPROVEMENTS.md` — change history and what was fixed
- `AGENTS.md` — coding conventions
- `CLAUDE.md` — quick reference
