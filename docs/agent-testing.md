# Testing, CI, skills QA

> **Audience**: agents and contributors validating code changes.  
> **Entrypoint**: root [`AGENTS.md`](../AGENTS.md).

## Commands

```bash
npm test                         # unit only (excludes test/integration.test.ts)
npm run test:watch
npm run test:integration         # needs daemon; AGENTMEMORY_URL default http://localhost:3111
npm run test:all
npx vitest run test/<file>.ts
npx vitest run test/<file>.ts -t "filter"
npx vitest watch test/<file>.ts -t "filter"

# Python backfill tests (manual, not in CI/npm):
pytest test/backfill_sessions_test.py -v
```

Before claiming done on engine changes: **`npm test`** green (and `npm run build` if hooks/tools changed).

## Framework

- **Vitest** (no `vitest.config.*` — defaults, Node env)  
- Unit files: `test/*.test.ts` (flat layout)  
- Integration: `test/integration.test.ts` excluded from `npm test`  
- No coverage thresholds, no snapshot tests, no ESLint  

## Patterns

| Pattern | Notes |
|---------|-------|
| `mockKV()` / `mockSdk()` | In-memory Map KV + registerFunction/trigger; see `test/helpers/mocks.ts` and `test/observe.test.ts` |
| `vi.mock("iii-sdk")` | Stub `registerWorker` + fake sdk |
| `vi.mock("../src/logger.js")` | Suppress log noise |
| Prefer arg-injected mocks | Over mocking the SUT wholesale |
| `describe` → `it` | Behavior names; issue refs in titles when relevant |
| Integration | Real `fetch` to daemon; fails if `/livez` down |
| Hook scripts | Spawn bundled `.mjs` as child process (e.g. `test/post-tool-use.test.ts`) |

## Benchmarks & eval

| Area | Entry | Needs daemon? |
|------|-------|---------------|
| Load | `npm run bench:load` → `benchmark/load-100k.ts` | Yes |
| Offline quality | `benchmark/quality-eval.ts` + `dataset.ts` | No |
| LongMemEval | `npm run eval:longmemeval` | Adapter-dependent |
| Coding-life | `npm run eval:coding-life` | Adapter-dependent |

Eval adapters: `eval/runner/adapters/` (`grep`, `vector`, `agentmemory`). Sandbox: `eval/scripts/sandbox.sh` (ports 3411/3412).

## CI

- Matrix: ubuntu + macos × Node 20 + 22; `fail-fast: false`  
- Steps: install → `npm run build` → `npm run skills:check` → `npm test`  
- No Windows, no integration suite, no coverage gate  
- `scripts/check-env-example.mjs` keeps `.env.example` aligned with `AGENTMEMORY_*` usage  

## Skills QA

```bash
npm run skills:gen     # regenerate REFERENCE.md from tools-registry, API, env, hooks
npm run skills:check   # frontmatter, “Use when”, line limits, plugin skill counts
```

Invocable + reference skills live under `plugin/` (counts change over time — trust `skills:check` and manifests, not memorized numbers).

## Live install debug

```bash
bash scripts/status.sh
bash scripts/health.sh
# or supervised tree:
bash scripts/am-daemon.sh status
bash scripts/am-daemon.sh health
# compress queue / zombie plateau (#72):
bash scripts/queue-diag.sh
python3 scripts/queue-reconcile.py --check
```
