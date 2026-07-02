# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agentmemory` is a persistent memory system for AI coding agents (Claude Code, Codex, Cursor, pi, OpenCode, etc.). It runs as an [iii-engine](https://iii.dev) worker: a single Node.js process on port `3111` that captures tool calls via agent-specific hooks, stores them in a SQLite-backed KV, and serves hybrid search (BM25 + vector + graph, fused via RRF). The user's coding agent never sees the memory layer — it just queries it through MCP or REST when relevant context is needed.

The system is **not** a library you import. It's a CLI daemon (`agentmemory`) that user agents connect to. Source files in `src/` are bundled to `dist/` via `tsdown` and shipped as the npm package `@agentmemory/agentmemory`.

## Common commands

```bash
npm install              # one-time setup; pulls iii-engine binary on first run via the CLI
npm run dev              # hot-reload dev mode: tsx src/index.ts
npm run build            # production build: tsdown → dist/, also copies config + viewer assets
npm test                 # vitest unit tests (~1,400+ tests; excludes test/integration.test.ts)
npm run test:watch       # vitest watch mode
npm run test:integration # integration suite (requires a running iii-engine + services)
npm run test:all         # both unit + integration

# single test (any of these forms work)
npx vitest run test/observe.test.ts
npx vitest run test/observe.test.ts -t "should dedup"
npx vitest watch test/consolidation-pipeline.test.ts

# skill generation (reference skills + table of contents)
npm run skills:gen
npm run skills:check

# eval harnesses (adapters live in eval/runner/)
npm run eval:longmemeval
npm run eval:coding-life
```

### Built outputs

`npm run build` produces three output trees; do not hand-edit any of them — the source of truth is in `src/`, `plugin/`, and `iii-config*.yaml`:

| Output path | Source | Purpose |
|---|---|---|
| `dist/` | `src/index.ts`, `src/cli.ts`, `src/mcp/standalone.ts` | npm-publishable package (`.mjs`, `.d.mts`, `cli.mjs` binary) |
| `dist/hooks/` | `src/hooks/*.ts` (one per lifecycle event) | Bundled hook scripts shipped with the package |
| `plugin/scripts/` | same `src/hooks/*.ts` | Bundled hook scripts shipped with the Claude/Codex/Copilot plugin |

If you change a hook, run `npm run build` to refresh both `dist/hooks/` and `plugin/scripts/` — the `tsdown.config.ts` declares them as parallel entry points. Editing the bundled `.mjs` directly is futile; the next build overwrites it.

## Architecture (the big picture)

```
                ┌─────────────────────────────┐
   Claude Code  │   src/hooks/*.ts            │  one standalone Node script per hook event
   Codex CLI    │   (bundled → plugin/scripts │
   OpenCode     │    and dist/hooks)          │
   pi / omp     └──────────────┬──────────────┘
                               │ fetch POST /agentmemory/{observe,session/*,...}
                               ▼
                ┌─────────────────────────────┐
                │   iii-engine  (port 49134)  │  WS triggers; not in this repo
                │     ├ REST :3111            │  ─┐
                │     └ WS   :49134           │   │ HTTP triggers registered by
                └──────────────┬──────────────┘   │ src/triggers/api.ts
                               │                  │
                               ▼                  │
                ┌─────────────────────────────┐   │
                │   this repo (src/index.ts)  │ ◀─┘
                │     registers mem::* fns    │
                │     uses StateKV (SQLite)   │
                └─────────────────────────────┘
```

The three core abstractions are iii's primitives. **Every read/write/observe goes through `registerFunction` / `registerTrigger` / `sdk.trigger()`**. There is no in-process HTTP layer, no Express, no direct SQLite access from request handlers. State lives in `KV.scopes` (see `src/state/schema.ts`) and is read/written via `kv.get` / `kv.set` / `kv.update` / `kv.list`.

### Directory map

| Path | What lives here |
|---|---|
| `src/index.ts` | Worker bootstrap. Calls every `register*Function` (50+) and loads env config. **Single longest file in the repo (~600+ lines).** Adding a new function = import + register call here. |
| `src/functions/` | One file per `mem::*` function: `observe`, `remember`, `search`, `smart-search`, `compress`, `consolidate`, `auto-forget`, `evict`, `claude-bridge`, `graph`, … Each file exports a `register*Function(sdk, kv, …)` that calls `sdk.registerFunction("mem::name", handler)`. |
| `src/hooks/` | Standalone Node hook scripts consumed by Claude Code / Codex / OpenClaw. Read JSON from stdin, POST to REST, exit. **Not bundled with the engine** — these are bundled into `plugin/scripts/` (Claude plugin) and `dist/hooks/` (npm package) by `tsdown`. |
| `src/hooks/_project.ts` | Shared `resolveProject(cwd?)` helper used by every Claude hook. Priority: `AGENTMEMORY_PROJECT_NAME` → `git rev-parse --show-toplevel` → `basename(cwd)`. |
| `src/triggers/api.ts` | HTTP trigger definitions for the 128 REST endpoints. Each is `sdk.registerFunction("api::*", handler) + sdk.registerTrigger({type:"http",...})`. |
| `src/triggers/events.ts` | Cross-system event triggers (`event::session::started`, `event::session::stopped`, `event::obs::*`). |
| `src/state/` | SQLite adapter (`kv.ts`), schema (`schema.ts`), vector index (`vector-index.ts`), BM25 (`search-index.ts`), hybrid fusion (`hybrid-search.ts`), dedup (`dedup.ts`), stemmer/synonyms/CJK segmenter. |
| `src/mcp/` | MCP server shim (`server.ts`) + tool registry (`tools-registry.ts`) + standalone entrypoint. |
| `src/cli/` | `agentmemory` CLI: connect-wizard, doctor diagnostics, onboarding, splash, remove plan. |
| `src/providers/` | LLM providers (Anthropic, OpenAI, OpenRouter, Gemini, MiniMax, local-Ollama, agent-SDK fallback) + embedding providers (local, OpenAI, Cohere, Voyage, Gemini). |
| `src/prompts/` | LLM prompt templates for compress / consolidate / summarize / extract / reflect. |
| `src/health/`, `src/auth.ts`, `src/config.ts`, `src/logger.ts`, `src/types.ts`, `src/version.ts` | Cross-cutting infra. |
| `integrations/` | Per-agent extensions: `omp/` (Oh My Pi), `pi/` (Pi coding agent), `openclaw/`, `hermes/`, `filesystem-watcher/`. Each is its own `package.json`; the engine never imports them — they're loaded by the host agent's plugin system. |
| `plugin/` | Claude Code / Codex plugin manifest (`plugin.json`, `.claude-plugin/plugin.json`), bundled hook scripts, OpenCode plugin, and 15 invocable + 7 reference skills. |
| `packages/` | Future home for split-out packages; currently empty / placeholder. |
| `test/` | vitest suite — 131 files. See "Testing patterns" below. |
| `eval/`, `benchmark/`, `docs/reviews/`, `docs/benchmarks/`, `docs/issues/` | Eval harnesses, perf benchmarks, prior review reports, fresh-issue logs from this session. |
| `deploy/` | One-click deploy templates (fly / railway / render / coolify). |
| `iii-config.yaml`, `iii-config.docker.yaml` | Engine config (worker registrations, ports, observability). Copied to `dist/` by build. |

### Data flow on a single tool call

```
Claude Code PostToolUse fires
  └─ plugin/scripts/post-tool-use.mjs (Node, exits in ~500ms)
      └─ POST /agentmemory/observe with {hookType, sessionId, project, cwd, timestamp, data}
          └─ iii-engine HTTP trigger → api::observe handler (src/triggers/api.ts)
              └─ sdk.trigger({function_id:"mem::observe", payload})
                  └─ src/functions/observe.ts handler
                      ├─ privacy filter (src/functions/privacy.ts) — strip secrets
                      ├─ SHA-256 fingerprint dedup (src/state/dedup.ts, 5min window)
                      ├─ kv.set(KV.observations(sessionId), observation)
                      ├─ (optional) sdk.trigger mem::compress → LLM summarization
                      └─ sdk.trigger mem::embed → vector index update
                          └─ BM25 + vector indexes auto-refresh
```

`src/functions/observe.ts` is the most-trafficked file — start there when debugging "memory not being saved" or "memory is duplicated".

## Key conventions (where AGENTS.md is the source of truth)

`AGENTS.md` at the repo root is the canonical convention doc. Re-read it before adding tools, endpoints, KV scopes, audit ops, or bumping version — it lists the 5-8 files that must stay in sync. The most-easily-missed one: **tool counts**. `src/index.ts` logs the count at boot; `test/mcp-standalone.test.ts` asserts it; `README.md`, `plugin/.claude-plugin/plugin.json`, `plugin/plugin.json`, and `plugin/.mcp.copilot.json` all reference it. Update all of them or tests fail.

## Testing patterns

- Test files are `*.test.ts` in `test/`. Integration tests live in `test/integration.test.ts` (excluded from `npm test` because they need a running engine + services).
- Mock pattern is **`vi.mock("iii-sdk")`** at the top of the file, providing a stub `registerWorker` that returns a fake `sdk` whose `.trigger` is a `vi.fn()`. Look at `test/observe.test.ts` for the canonical pattern.
- The `test/` directory mirrors `src/` — `test/functions/` would have one file per source function, but most live flat at `test/` top level.
- For hook-script tests, look at `test/post-tool-use.test.ts` — they spawn the bundled `.mjs` script as a child process.

## Gotchas that span multiple files

These are non-obvious invariants that bite when changing only one place:

- **`iii-sdk` `TriggerAction` is a discriminated union**, not a string. Use `TriggerAction.Void()` for fire-and-forget, never `action: "void"` (a bare string). The runtime checks `action?.type`; a bare string falls into the sync branch and blocks the event loop. See `src/index.ts` for the 5+ correct call sites.
- **`setInterval` timers in `src/index.ts` MUST call `.unref()`** so the engine process can exit cleanly. They also must be added to the `_cleanupTimers` array so the `shutdown()` handler can `clearInterval` them on SIGINT/SIGTERM.
- **`src/functions/` handlers MUST whitelist input fields** before passing them to `sdk.trigger()` — never pass the raw request body downstream, or a malicious caller can inject extra function_id payloads.
- **iii KV scopes are fixed at startup** via the `KV` constant in `src/state/schema.ts`. Adding a scope = (1) add the entry to `KV`, (2) add the TypeScript interface in `src/types.ts`. The runtime rejects unknown scopes.
- **`src/hooks/` scripts are bundled twice** (into `plugin/scripts/` and `dist/hooks/`) by `tsdown`. Both must regenerate on every build. If you see "hook script out of sync" warnings, run `npm run build`.
- **`AGENTMEMORY_URL` and `AGENTMEMORY_SECRET` propagate from parent shell → hook script → MCP shim** as plain env vars. The MCP shim falls back to `http://localhost:3111` when `AGENTMEMORY_URL` is empty.
- **iii-engine binary is pinned to v0.11.2.** Newer engines (v0.11.6+) introduce a sandbox-via-`iii worker add` model that agentmemory hasn't been refactored for. Don't upgrade the engine until the refactor lands.
- **The OMP / pi / openclaw integrations under `integrations/` are loaded by the host agent's plugin system, not by the engine.** They make raw HTTP calls to `AGENTMEMORY_URL/agentmemory/*`. They share no code with the engine — duplication of `truncate`, `getText`, `apiPost` is currently a known wart (`docs/issues/2026-07-02-omp-adaptation-review/`).

## Things you should NOT do

- Don't add `Express` / `Fastify` / `pg` / `redis` / `mongoose` / standalone-SQLite-orm dependencies. iii-engine replaces them.
- Don't add new top-level npm dependencies without checking the existing `package.json` — `iii-sdk`, `@anthropic-ai/sdk`, `zod`, `picocolors`, `@clack/prompts`, `dotenv` are the only allowed runtime deps. Local embedding / CJK segmenter deps live under `optionalDependencies`.
- Don't bypass iii by writing to `data/state_store.db` directly. Always go through `kv.*`.
- Don't hand-edit anything in `dist/`, `dist/hooks/`, or `plugin/scripts/` — these are generated by `npm run build`.
- Don't bump `iii-sdk` past `0.11.2` without verifying the refactor for v0.11.6+ sandbox model is complete.

## Useful adjacent docs

- `AGENTS.md` — canonical coding conventions, file-sync checklists, hook-script patterns (READ THIS)
- `README.md` — user-facing install / quick-start / API reference (the source of truth for end-user docs)
- `DESIGN.md` — Lamborghini visual design system (only relevant for the `website/` work)
- `ROADMAP.md` — what's planned for upcoming versions
- `CHANGELOG.md` — version-by-version change log
- `docs/reviews/<date>-*-code-review.md` — prior max-effort code reviews; format = problem / impact / fix / verification. If your change relates to a flagged issue, link to it.
- `docs/issues/<date>-*/` — local issue markdown from this session, indexed by README. 15 P0-P2 findings on `feat/omp-adaptation` already filed there.
- `docs/benchmarks/`, `benchmark/` — published retrieval / token / scale numbers
- `iii.dev/docs` — the underlying engine (worker / function / trigger / KV / streams / OTEL)