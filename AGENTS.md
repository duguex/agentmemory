# Agent instructions

> **Entrypoint only.** Hard rules + index. Prefer repository docs and code over pretraining.  
> Details: [`docs/agent-conventions.md`](docs/agent-conventions.md), [`docs/agent-testing.md`](docs/agent-testing.md), [`docs/README.md`](docs/README.md).  
> Package: `@agentmemory/agentmemory` · Node `>=20` · License Apache-2.0 · Source of version: `src/version.ts` / `package.json`.

## Precedence

1. User’s current explicit message  
2. Nearest nested `AGENTS.md` (if any)  
3. This file  
4. Linked docs / skills  

Harness adapters (`CLAUDE.md`, etc.) must **not** carry a second full rule body — import or symlink this file.

## Always-on

- **Stack**: Node.js ≥20, **npm**, TypeScript strict ESM; build with `tsdown`; tests with **vitest**.  
- **Engine pin**: `iii-sdk@0.11.2` — do **not** upgrade past 0.11.2 until sandbox (v0.11.6+) refactor lands.  
- **Shape**: CLI **daemon**, not an importable application library. Agents connect via hooks, MCP, or REST.  
- **Three primitives only**: `registerFunction` / `registerTrigger` / `sdk.trigger` — no Express/Fastify; no direct SQLite; all persistence via **StateKV** (`src/state/kv.ts`) and scopes in `src/state/schema.ts`.  
- **Fire-and-forget**: `TriggerAction.Void()` only — never `action: "void"`. Timers: `.unref()` + `_cleanupTimers[]`.  
- **API safety**: whitelist fields before `sdk.trigger()`; never pass raw request bodies.  
- **Generated trees**: do not hand-edit `dist/`, `dist/hooks/`, or `plugin/scripts/` — run `npm run build`.  
- **Deps**: do not add Express/Fastify/pg/redis/mongoose/standalone SQLite ORMs. Allowed runtime set is listed in `docs/agent-conventions.md`.  
- **Done gate**: `npm test` green for code changes; after hooks → `npm run build`; after tools/API/env → `npm run skills:gen` && `npm run skills:check`.  
- **Counts**: tool/endpoint/test counts drift — update boot logs, tests, README, and plugin manifests together (checklists in conventions doc). Do not invent numbers from memory.  
- **Retrieval-led**: for architecture and env, read linked docs / `.env.example` rather than guessing.

## Development commands

```bash
npm install
npm run dev                 # tsx src/index.ts
npm run build
npm start                   # node dist/cli.mjs
npm test                    # unit (excludes integration)
npm run test:integration    # needs daemon @ localhost:3111
npm run test:all
npx vitest run test/<file>.ts
npm run skills:gen && npm run skills:check
bash scripts/status.sh      # live install debug
bash scripts/health.sh
```

## Read on demand

| When | Read first |
|------|------------|
| Architecture, data flow, patterns, checklists, deps, gotchas | [`docs/agent-conventions.md`](docs/agent-conventions.md) |
| Tests, CI, evals, skills QA | [`docs/agent-testing.md`](docs/agent-testing.md) |
| Deep system / process model | [`docs/architecture.md`](docs/architecture.md) |
| Open production issues | [`docs/known-issues.md`](docs/known-issues.md) |
| Compress queue stuck / depth plateau / zombie jobs | [`docs/known-issues.md`](docs/known-issues.md) §6b; `python3 scripts/queue-reconcile.py --check`; `bash scripts/am-daemon.sh health` |
| Doc map / reading order | [`docs/README.md`](docs/README.md) |
| Install agentmemory on a user machine (self-setup) | [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) |
| User-facing product docs (short) | [`README.md`](README.md) |
| Full product / install depth | [`docs/user/guide.md`](docs/user/guide.md) |
| Website / visual only | [`DESIGN.md`](DESIGN.md) + `website/` |
| Memory not saved / dupes | `src/functions/observe.ts` + dedup |
| New MCP tool / REST / version bump | checklists in `docs/agent-conventions.md` |
| Prior reviews / local issues | `docs/reviews/`, `docs/issues/` |

## Orientation shortcuts

| Need | Go to |
|------|--------|
| Highest-traffic ingest | `src/functions/observe.ts` |
| Register new `mem::*` | implement under `src/functions/`, wire in `src/index.ts` |
| REST surface | `src/triggers/api.ts` |
| MCP tools | `src/mcp/tools-registry.ts` + `server.ts` |
| Integrations (OMP/pi/…) | `integrations/*` — host-loaded, HTTP to daemon |

## Keep in sync

| Topic | Files that must agree |
|-------|------------------------|
| Version | `package.json`, `src/version.ts`, export-import types/tests, plugin manifests |
| MCP tool set | tools-registry, server switch, api if exposed, index boot log, mcp tests, README, plugin json |
| Env surface | code usage ↔ `.env.example` (CI check) |
| Agent rules | This file is canonical; `CLAUDE.md` = short local summary + `@AGENTS.md` (no second full body) |
