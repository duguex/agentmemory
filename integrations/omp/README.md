# agentmemory ↔ OMP (Oh My Pi)

Extension entry: `index.ts` (loaded from `~/.omp/agent/settings.json`).

## What it does

| Mode | Behavior |
|------|----------|
| **Observe** (always when server reachable) | `tool_execution_*`, session lifecycle → `POST /agentmemory/observe` |
| **Inject** (opt-in) | `before_agent_start` → `POST /agentmemory/search` → append `## Recalled from memory` to **systemPrompt** (once per session) |
| **Tools** | `agentmemory_status` / `agentmemory_save` / `agentmemory_search` |

Inject is **not** the Claude `enrich` hook path.

## Required environment (on the **omp** process)

```bash
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_SECRET=omp-memory-local   # preferred; also read from ~/.agentmemory/.env as fallback (#70)
export AGENTMEMORY_INJECT_CONTEXT=true       # optional; default off = observe only
export AGENTMEMORY_INJECT_DEBUG=true         # optional; stderr inject diagnostics
```

If `AGENTMEMORY_SECRET` is missing from the omp process **and** from `~/.agentmemory/.env`, health returns 401 and inject is skipped (with a console warning when inject is requested).

## Enable extension

`~/.omp/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/agentmemory/integrations/omp/index.ts"
  ]
}
```

## Verify inject (CLI)

```bash
# daemon must be up
bash /path/to/agentmemory/scripts/am-daemon.sh health

export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_SECRET=omp-memory-local
export AGENTMEMORY_INJECT_CONTEXT=true
export AGENTMEMORY_INJECT_DEBUG=true

omp -p --no-session --no-tools --thinking=off --max-time=100 \
  --cwd /path/to/some/project \
  "Ask something that exists in your memory corpus"

# Expect on stderr:  [agentmemory:inject] inject ok lines=N
# With INJECT=false: [agentmemory:inject] skip: INJECT_CONTEXT not true
```

Stdout may **not** show `## Recalled from memory` (lives in system prompt).

## Ops

- Prefer `scripts/am-daemon.sh` for the memory daemon (supervised single worker).
- Details: `docs/architecture.md` (OMP section), `docs/superpowers/plans/2026-07-13-usefulness-trial.md` appendix C.
