# E2E Scorecard — Phase B1 (Freeze)

**Date:** 2026-07-12  
**Daemon health:** `ok` workers=2 cli=1 iii=1 exec_worker=1 (0.24 s)  
**How to re-run:** Use the `curl` command in the _How to measure_ section below against a healthy daemon.

---

## Grounded queries

Each query targets a real corpus topic verified by `/agentmemory/smart-search` on this host.  
Columns Hit / Top / Inject / Reduced — Inject filled by B3 (☑ path-ok for all 5); Reduced still requires live agent session.

| # | Query | Expected cue | Hit | Top session/obs | Inject tried? | Reduced re-explain? | Notes |
|---|-------|--------------|-----|----------------|--------------|--------------------|-------|
| 1 | `VASP relaxation workflow INCAR KPOINTS` | `kpoints_reader.hpp` file_write (obs_mrfc5p9p) | ☑ | `auto-mrfc4024` obs_mrfc5p9p "Write kpoints_reader.hpp (3481 bytes)" | ☑ path-ok | n/a (no live agent session this run) | VASP INCAR migration guide and relax.hpp implementation sessions present |
| 2 | `agentmemory save search recall operations` | `Agent Memory System Directory Structure Overview` (obs_mrgtdqpf) | ☑ | `auto-mrgtdnp8` obs_mrgtdqpf "Agent Memory System Directory Structure Overview" | ☑ path-ok | n/a (no live agent session this run) | Covers save hook, architecture docs, vector index rebuild |
| 3 | `compress summary DLQ dead letter queue` | `mem::compress DLQ depth=10` (obs_mrhqutie) | ☑ | `auto-mrhodfyz` obs_mrhqutie "agentmemory queue-diag: mem::compress DLQ depth=10" | ☑ path-ok | n/a (no live agent session this run) | Queue-diag output and compress.ts grep results confirmed |
| 4 | `Ollama Qwen local LLM model inference` | `models.yml reasoning effort configuration` (obs_mrhllsxt) | ☑ | `auto-mrhjmhbb` obs_mrhllsxt "oh-my-pi models.yml reasoning effort configuration" | ☑ path-ok | n/a (no live agent session this run) | Opencode provider config, model catalog, provider_models_cache.json all present |
| 5 | `backfill session restore history` | `backfill-019ec76e` (WAVECAR restore session) | ☑ | `backfill-019ec76e-...` obs_mr9pfwb6 "Restored WAVECAR/INCAR/OUTCAR from git commit 55f032b" | ☑ path-ok | n/a (no live agent session this run) | Subprocess trace, git restore, _backfill-*_ sessions confirmed |

---

## How to measure

### Prerequisites
- Daemon must be healthy: `bash scripts/am-daemon.sh health`
- Secret token: `omp-memory-local`

### Curl template
```bash
curl -s -X POST http://localhost:3111/agentmemory/smart-search \
  -H "Authorization: Bearer omp-memory-local" \
  -H "Content-Type: application/json" \
  -d '{"query":"<QUERY>","top_k":5}' | python3 -m json.tool
```

### Expected for a passing query
1. Non-zero `results` array
2. At least one result containing the Expected cue (keyword or sessionId fragment)
3. Daemon returns HTTP 200 and latency < 1 s

### Checking five at once
```bash
for q in \
  "VASP relaxation workflow INCAR KPOINTS" \
  "agentmemory save search recall operations" \
  "compress summary DLQ dead letter queue" \
  "Ollama Qwen local LLM model inference" \
  "backfill session restore history"; do
  echo "=== $q ==="
  curl -s -X POST http://localhost:3111/agentmemory/smart-search \
    -H "Authorization: Bearer omp-memory-local" \
    -H "Content-Type: application/json" \
    -d "$(echo "{}" | python3 -c "import json,sys; d=json.load(sys.stdin); d['query']='$q'; d['top_k']=3; print(json.dumps(d))")" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  results={len(d.get(\"results\",[]))}')"
done
```


---

## B2 results

**Date:** 2026-07-12  
**Run:** `top_k=10` via `/agentmemory/smart-search`  
**Result:** 5/5 — all 5 queries hit their Expected cue in the top 10 results.

| # | Expected cue found? | Top rank | Matching obs/session |
|---|---------------------|----------|----------------------|
| 1 | ☑ obs_mrfc5p9p in result [2] | #2 | `auto-mrfc4024` obs_mrfc5p9p "Write kpoints_reader.hpp (3481 bytes)" |
| 2 | ☑ obs_mrgtdqpf and title match in result [0] | #1 | `auto-mrgtdnp8` obs_mrgtdqpf "Agent Memory System Directory Structure Overview" |
| 3 | ☑ obs_mrhqutie and title "DLQ depth=10" in result [0] | #1 | `auto-mrhodfyz` obs_mrhqutie "agentmemory queue-diag: mem::compress DLQ depth=10" |
| 4 | ☑ obs_mrhllsxt and title "models.yml reasoning effort" in result [5] | #5 | `auto-mrhjmhbb` obs_mrhllsxt "oh-my-pi models.yml reasoning effort configuration" |
| 5 | ☑ sessionId "backfill-019ec76e-*" in result [1] | #1 (tied) | `backfill-019ec76e-...` obs_mr9pfwb6 "Restored WAVECAR/INCAR/OUTCAR from git commit 55f032b" |

**Go-hint:** N≥3 → search gate provisional pass for search-only. B3 — Inject path verified (see below). B4 (final go/no-go) still pending.

## B3 results

**Date:** 2026-07-12  
**Env:** `AGENTMEMORY_INJECT_CONTEXT=true` (confirmed in `~/.agentmemory/.env` line 24)  
**Daemon health:** `ok` workers=2 cli=1 iii=1 exec_worker=1  
**Smoke method:** REST API calls + compiled hook binary stdin fixtures

| Check | Result | Detail |
|-------|--------|--------|
| env var | ☑ | `AGENTMEMORY_INJECT_CONTEXT=true` in `~/.agentmemory/.env` |
| session-start hook inject path | ☑ | POST `/agentmemory/session/start` returns HTTP 200; writes context to stdout when present |
| pre-tool-use hook inject path | ☑ | POST `/agentmemory/enrich` returns **1534 chars** of context for `Read` on `kpoints_reader.hpp`; same for `Edit` and `Grep` |
| binary hook smoke (stdin → .mjs) | ☑ | `dist/hooks/pre-tool-use.mjs` emits `<agentmemory-relevant-context>` block for Read/Edit/Grep tool payloads |
| INJECT_CONTEXT=false guard | ☑ | Both hooks short-circuit when env var is not `"true"` |
| "Reduced re-explain" | n/a | Cannot measure without live Claude Code agent session |

**Residual risk:** The "reduced re-explain" benefit is hypothetical until a live agent session demonstrates fewer repeated explanation rounds. The inject path itself is fully wired and produces meaningful context.

**Status:** DONE — all 5 rows marked `☑ path-ok`; Reduced set to `n/a (no live agent session this run)`.

---

## B4 Gate decision

**Date:** 2026-07-13  
**Decision: GO → Phase C**

| Criterion (plan) | Result |
|------------------|--------|
| Search hits ≥ 3/5 | **5/5** (B2) |
| Inject path not broken | **path-ok** (B3: enrich ~1.5KB context; hooks smoke) |
| Process healthy during B | **yes** (`am-daemon.sh health` ok) |
| Reduced re-explain measured | **n/a** — residual risk; not a no-go under plan wording |

**Rationale:** Plan Task B4: *If ≥3/5 search hits AND inject path not broken → Phase C.* Both met. Live-agent “less re-explain” remains a 7-day north-star check, not a Phase B blocker.

**Next (plan order):** Phase C — single worker story (recommended **C-cli**).  
**Do not open:** Phase D/E feature work until C exit criteria met.  
**Ops reminder:** only `bash scripts/am-daemon.sh …` for day-to-day.
