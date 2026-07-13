# Repository Guidelines

## Project Overview

**agentmemory** — persistent memory for AI coding agents (Claude Code, Codex, Cursor, OpenCode, pi, OMP, Hermes, and 15+ others). Runs as an [iii-engine](https://iii.dev) worker: a single Node.js process on port `3111` that captures tool calls via agent-specific hooks, stores them in a SQLite-backed KV store (via iii-engine's `StateModule`), and serves hybrid search (BM25 + Vector + Graph, fused via RRF).

- **Package**: `@agentmemory/agentmemory` (npm)
- **Version**: `0.9.27` (`src/version.ts`)
- **License**: Apache-2.0
- **Node**: `>=20.0.0` (CI: Node 20 + 22 on ubuntu/macos)
- **Engine pin**: `iii-sdk@0.11.2` — do not upgrade past v0.11.2 until the sandbox (v0.11.6+) refactor lands
- **Surface**: 53 MCP tools, 130 REST endpoints, 13 lifecycle hooks, 15 skills, 60+ `mem::*` function modules, 140 unit test files

This is a **CLI daemon**, not an importable library. Agents connect via hooks, MCP (`npx @agentmemory/mcp`), or REST.

---

## Architecture & Data Flow

### Three Primitives (never bypassed)

All state changes go through iii-engine's three primitives — no Express, no Fastify, no direct SQLite:

1. `sdk.registerFunction("mem::<name>", handler)` — define a callable function
2. `sdk.registerTrigger({ type: "http" | "event", function_id, config })` — bind HTTP / event routes
3. `sdk.trigger({ function_id, payload })` — invoke a function (internal cross-call)

Function ID namespaces: `mem::` (core), `api::` (REST), `event::` (durable subscribers), `mcp::` (MCP), `middleware::` (auth).

### Hook → REST → Worker Flow

```
Agent Hook Script (plugin/scripts/<hook>.mjs  ← built from src/hooks/*.ts)
  └─ fetch POST /agentmemory/{observe,session/*,...}
      └─ iii-engine HTTP trigger → api::<name> handler
          └─ sdk.trigger({ function_id: "mem::<name>", payload })
              └─ src/functions/<name>.ts handler
                  ├─ privacy filter (strip secrets)
                  ├─ SHA-256 fingerprint dedup (5min window)
                  ├─ kv.set(KV.<scope>(key), data)
                  └─ (opt) mem::compress / mem::embed → index update
```

### Search Architecture — TripleStream + RRF

| Leg | Mechanism | Default |
|-----|-----------|---------|
| BM25 | Inverted index + stemmer/synonym/CJK (k1=1.2, b=0.75) | Built-in |
| Vector | Float32Array embeddings, cosine similarity | all-MiniLM-L6-v2 (384d, local) |
| Graph | Knowledge graph traversal (concept nodes + typed edges) | Built-in |

Fusion: RRF (k=60) → cross-encoder reranker (Xenova/ms-marco) → session diversity → KV enrichment.

### Bootstrap Sequence (`src/index.ts`)

1. `loadConfig()` / embedding + fallback config
2. `createProvider` / `createFallbackProvider` → `ResilientProvider`
3. `createEmbeddingProvider` (+ optional image embeddings)
4. `registerWorker(sdk)` → WebSocket to iii-engine
5. `new StateKV(sdk)` → sole persistence bridge
6. Wire search globals (`getSearchIndex` / `getVectorIndex`)
7. Register ~60 `mem::*` function modules + API/event/MCP triggers
8. Periodic timers (auto-forget, evict, consolidation, decay) — all `.unref()` + `_cleanupTimers[]`
9. `IndexPersistence.load()`; fire-and-forget rebuild if stale
10. `startViewerServer()` on `REST_PORT + 2`
11. SIGINT/SIGTERM shutdown (flush indexes, clear timers)

### Write / Read / Event Paths

- **Write**: Hook/REST → `mem::observe` → KV + stream → optional LLM compress → vector/BM25 update
- **Read**: MCP/REST → `mem::search` / `mem::smart-search` → HybridSearch triple-stream → RRF → rerank
- **Events**: `event::session::{started,stopped,ended}` → summarize / graph-extract / slot-reflect

---

## Key Directories

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker bootstrap. **Add new function registrations here.** |
| `src/functions/` | One module per `mem::*` handler (`registerXxx(sdk, kv, …)`). Start with `observe.ts` for ingest bugs. |
| `src/state/` | `kv.ts` (StateKV), `schema.ts` (KV scopes), BM25 (`search-index.ts`), vectors (`vector-index.ts`), hybrid fusion, reranker, dedup, keyed-mutex, stemmer/CJK. |
| `src/triggers/` | `api.ts` (130 REST endpoints), `events.ts` (session lifecycle). |
| `src/mcp/` | MCP server, `tools-registry.ts` (53 tools across version tiers), standalone stdio, REST proxy, InMemoryKV. |
| `src/hooks/` | 13 lifecycle hooks + `_project.ts` / `sdk-guard.ts`. Bundled to `plugin/scripts/` and `dist/hooks/`. |
| `src/providers/` | LLM + embedding providers; factory + Resilient/Fallback/CircuitBreaker wrappers. |
| `src/cli/` + `src/cli.ts` | CLI: start/stop/status/doctor/init/connect (20+ agent adapters). |
| `src/prompts/` | LLM templates (compress, summarize, graph-extract, reflect, vision, XML). |
| `src/viewer/` | Web dashboard SPA + server (port rest+2). |
| `src/health/`, `src/telemetry/`, `src/eval/` | Health monitor, OTEL meters, quality validators / metrics store. |
| `test/` | 140 vitest files (flat). Helpers in `test/helpers/mocks.ts`. |
| `integrations/` | Host-loaded plugins: `omp/`, `pi/`, `hermes/` (Python), `openclaw/`, `filesystem-watcher/`. **Not imported by the engine.** |
| `plugin/` | Agent manifests, hooks configs, 15 skills, bundled scripts. |
| `scripts/` | Ops: backfill, backup, status/health/trace, DLQ drain, skills gen/check. |
| `benchmark/`, `eval/` | Load/quality benches; adapter-pattern eval (grep / vector / agentmemory). |
| `deploy/` | fly / railway / render / coolify templates (npm install at image build). |
| `docs/` | Architecture, known-issues, IMPROVEMENTS, recipes (read order in `docs/README.md`). |
| `website/` | Next.js marketing site (see `DESIGN.md` only for this tree). |

---

## Development Commands

```bash
npm install                # Setup; iii-engine binary pulled via CLI on first run
npm run dev                # Hot-reload: tsx src/index.ts
npm run build              # tsdown → dist/ + plugin/scripts/; copies configs + viewer
npm start                  # node dist/cli.mjs
npm test                   # vitest run (excludes test/integration.test.ts)
npm run test:watch         # vitest watch (same exclude)
npm run test:integration   # needs daemon at localhost:3111
npm run test:all           # unit + integration
npm run skills:gen         # regenerate skill REFERENCE.md from source
npm run skills:check       # skill structure + drift CI check
npm run bench:load         # HTTP load harness (daemon)
npm run eval:longmemeval   # LongMemEval runner
npm run eval:coding-life   # in-house coding-agent-life eval

# Single test
npx vitest run test/observe.test.ts
npx vitest run test/observe.test.ts -t "should dedup"

# Ops (first stop when debugging a live install)
bash scripts/status.sh
bash scripts/health.sh
```

### Build outputs (do NOT hand-edit)

| Output | Source | Purpose |
|--------|--------|---------|
| `dist/index.mjs` + `.d.mts` | `src/index.ts` | Worker bundle |
| `dist/cli.mjs` | `src/cli.ts` | `agentmemory` binary |
| `dist/standalone.mjs` | `src/mcp/standalone.ts` | Standalone MCP |
| `dist/hooks/*.mjs` | `src/hooks/*.ts` | Hooks for npm users |
| `plugin/scripts/*.mjs` | `src/hooks/*.ts` | Hooks for plugin users |

`tsdown` also never-bundles `@xenova/transformers`, onnxruntime-*, Anthropic SDKs.

---

## Code Conventions & Common Patterns

### Typing & Language

- TypeScript **strict**, ESM only (`"type": "module"`), target ES2022, `moduleResolution: bundler`
- Source imports use `.js` extensions (`from "./foo.js"`) even for `.ts` files
- Prefer clear names over comments that restate the code
- IDs: `fingerprintId()` (SHA-256 content hash), `generateId()` (unique)
- Capture timestamps once: `const now = new Date().toISOString()`

### Function Registration

```typescript
export function registerYourFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::your-function",
    async (data: { sessionId: string }) => {
      if (!data?.sessionId || typeof data.sessionId !== "string") {
        return { success: false, error: "sessionId required" };
      }
      await kv.set(KV.observations(data.sessionId), observation);
      await recordAudit(kv, "create", "mem::your-function", [data.sessionId]);
      return { success: true };
    },
  );
}
```

Handlers return `{ success, error?, skipped?, ... }`. Register the function from `src/index.ts`.

### REST Endpoint

```typescript
sdk.registerFunction("api::your-endpoint", async (req: ApiRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  // NEVER pass raw request body to sdk.trigger() — whitelist fields
  const body = req.body as Record<string, unknown>;
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { sessionId: body.sessionId },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

Auth: `middleware::api-auth` / Bearer vs `AGENTMEMORY_SECRET` (`timingSafeCompare` in `src/auth.ts`).

### MCP Tool Handler

```typescript
case "memory_your_tool": {
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { /* validated fields */ },
  });
  return {
    status_code: 200,
    body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
  };
}
```

Tool schemas live in versioned arrays in `tools-registry.ts` (`CORE_TOOLS`, `V040_TOOLS`, …). `AGENTMEMORY_TOOLS=core|all` (default **all** = 53 tools).

### Hook Script Patterns

Standalone Node scripts (no iii-sdk). Read JSON stdin → POST REST → exit.

**Context-injecting** (`pre-tool-use`, `pre-compact`, `session-start`):

```typescript
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  // write context to stdout for agent injection
} catch (e) {
  process.stderr.write(`hook error: ${e}\n`);
}
```

**Fire-and-forget** (`post-tool-use`, `notification`, `stop`, `session-end`, …):

```typescript
fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => {});
setTimeout(() => process.exit(0), 500).unref(); // 1500ms if multi-request
```

Project resolution (`src/hooks/_project.ts`): `AGENTMEMORY_PROJECT_NAME` → git toplevel → `basename(cwd)`.

### State & Search

- **StateKV only** — wraps `state::get/set/delete/list/update`. Never touch `data/state_store.db` directly.
- KV scopes are constants in `src/state/schema.ts` (`KV.observations(sessionId)`, etc.). Unknown scopes are rejected.
- BM25 + vector indexes are **in-memory**, persisted via `IndexPersistence`. After mutations call `scheduleIndexSave()` / `flushIndexSave()`.
- Concurrent scope writes: `withKeyedLock(key, fn)` from `state/keyed-mutex.ts`.
- Embedding providers use `withDimensionGuard` to prevent silent index corruption.

### Error Handling & Async

- Boundary validation: inline `typeof` guards; Zod in `src/eval/validator.ts` for eval paths
- Provider chain: `createBaseProvider` → `ResilientProvider` (retry) → optional `FallbackChainProvider` + `CircuitBreaker`
- Fire-and-forget periodic work: `sdk.trigger({ …, action: TriggerAction.Void() })` — **never** `action: "void"` (string blocks the event loop; runtime checks `action?.type`)
- `setInterval` timers **must** `.unref()` and join `_cleanupTimers[]`

### Audit

- `recordAudit(kv, operation, functionId, targetIds, details)` → `KV.audit`
- `safeAudit()` for fire-and-forget
- Scoped delete: one row per call; bulk sweeps: one batched row with count

### MCP Dual Mode

- **REST mode**: `registerMcpEndpoints()` on the worker
- **Standalone**: `standalone.ts` stdio JSON-RPC; probes daemon via `rest-proxy.ts`, else `InMemoryKV`

### Consistency Checklists

**Adding/removing MCP tools:**

1. `src/mcp/tools-registry.ts` — definition + `getAllTools()` composition
2. `src/mcp/server.ts` — `mcp::tools::call` switch case
3. `src/triggers/api.ts` — REST endpoint if exposed
4. `src/index.ts` — registration + boot log (`getAllTools().length`)
5. `test/mcp-standalone.test.ts` — count/name assertions
6. `README.md` — advertised counts
7. `plugin/.claude-plugin/plugin.json` / `plugin/plugin.json` / `plugin/.mcp.copilot.json`

**Adding REST endpoints:**

1. `src/triggers/api.ts`
2. `src/index.ts` boot log (`130 endpoints`)
3. `README.md` counts

**Bumping version:**

1. `package.json`
2. `src/version.ts` (`VERSION` + type union)
3. `src/types.ts` ExportData version union
4. `src/functions/export-import.ts` `supportedVersions`
5. `test/export-import.test.ts`
6. `plugin/.claude-plugin/plugin.json` + `plugin/plugin.json`

**Adding KV scopes:**

1. `src/state/schema.ts` — `KV` entry
2. `src/types.ts` — interface

**Adding audit operations:**

1. `src/types.ts` — `AuditEntry.operation` union

**After changing hooks:** run `npm run build` (refreshes both hook output trees).

**After changing tools/API/env:** run `npm run skills:gen` and `npm run skills:check`.

---

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry; registers functions, timers, viewer, index load |
| `src/cli.ts` | CLI entry (`agentmemory` binary) |
| `src/config.ts` | `~/.agentmemory/.env` + `process.env`; feature flags |
| `src/types.ts` | Core domain interfaces |
| `src/state/schema.ts` | KV/STREAM constants, id helpers |
| `src/state/kv.ts` | StateKV — only persistence abstraction |
| `src/state/hybrid-search.ts` | RRF triple-stream fusion + rerank |
| `src/functions/observe.ts` | Highest-traffic ingest path |
| `src/functions/search.ts` | Index singletons + `rebuildIndex()` |
| `src/triggers/api.ts` | All REST registrations |
| `src/mcp/tools-registry.ts` | 53 tool schemas, visibility filtering |
| `src/version.ts` | `VERSION = "0.9.27"` |
| `iii-config.yaml` / `iii-config.docker.yaml` | Engine workers, ports, stores |
| `.env.example` | Canonical env documentation (CI-checked) |
| `tsdown.config.ts` | Multi-entry ESM build (worker, CLI, MCP, hooks×2) |
| `INSTALL_FOR_AGENTS.md` | Agent self-install runbook |
| `CLAUDE.md` | Short Claude Code orientation + gotchas |
| `docs/architecture.md` | Deep architecture (4-process diagram, queues, storage) |
| `docs/known-issues.md` | Open production issues |

---

## Runtime / Tooling Preferences

| Aspect | Choice |
|--------|--------|
| Runtime | **Node.js** ≥20 (not Bun/Deno) |
| Package manager | **npm** (lockfiles gitignored; CI regenerates via `npm install --package-lock-only` then `npm ci --legacy-peer-deps`) |
| Build | **tsdown** (ESM, node20) |
| Dev runner | **tsx** |
| TypeScript | v6, strict, `noUnusedLocals` / `noUnusedParameters` |
| Tests | **vitest** v4 — no config file (defaults) |
| Lint/format | TypeScript strict only — no ESLint/Prettier |
| CI | `.github/workflows/ci.yml` — build + `skills:check` + unit tests |
| Publish | Release → three packages with provenance: `@agentmemory/agentmemory`, `@agentmemory/mcp`, `@agentmemory/fs-watcher` |

### Dependency Rules

**Allowed runtime:** `iii-sdk@0.11.2`, `zod`, `dotenv`, `picocolors`, `@clack/prompts`, `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`.

**Optional** (local embeddings / CJK / CLIP): `@xenova/transformers`, `onnxruntime-*`, `@node-rs/jieba`, `tiny-segmenter`.

**Do not add:** Express, Fastify, pg, redis, mongoose, standalone SQLite ORMs.

**Overrides:** `qs`, `ws`, `protobufjs` (security pins).

### Config Surface

Config merges `~/.agentmemory/.env` over `process.env`. Categories (see `.env.example`):

- LLM keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …
- Embeddings: `EMBEDDING_PROVIDER=local|openai|voyage|cohere|gemini|openrouter`
- Auth: `AGENTMEMORY_SECRET`
- Search: `BM25_WEIGHT`, `VECTOR_WEIGHT`, `TOKEN_BUDGET`
- Features: `AGENTMEMORY_AUTO_COMPRESS`, `AGENTMEMORY_INJECT_CONTEXT`, graph extraction, consolidation
- Ports: `III_REST_PORT=3111`, `III_ENGINE_URL=ws://localhost:49134`
- Tools: `AGENTMEMORY_TOOLS=core|all`
- Engine image pin: `AGENTMEMORY_III_VERSION` (compose)

Docker: `iiidev/iii:0.11.2`, ports 3111/3112/9464, volume for `/data`. Deploy templates generate HMAC secret on first boot; only 3111 is public.

### What Not To Do

- Don't bypass iii primitives or write `data/state_store.db` directly
- Don't hand-edit `dist/`, `dist/hooks/`, or `plugin/scripts/`
- Don't bump `iii-sdk` past `0.11.2` without the sandbox refactor
- Don't pass raw request bodies into `sdk.trigger()`
- Don't use `action: "void"` — use `TriggerAction.Void()`
- Don't leave `setInterval` without `.unref()` / `_cleanupTimers`
- Don't assume integrations share code with `src/` — they HTTP-call the daemon independently

---

## Testing & QA

### Framework

- **Vitest** v4.1.6, no `vitest.config.*` — default `**/*.{test,spec}.ts`, Node env
- **140** `test/*.test.ts` unit files; flat layout
- No coverage thresholds, no snapshot tests, no ESLint

### Commands

```bash
npm test                         # unit only (~excludes integration)
npm run test:integration         # AGENTMEMORY_URL (default http://localhost:3111)
npm run test:all
npx vitest run test/<file>.ts
npx vitest watch test/<file>.ts -t "filter"
# Python backfill tests (manual, not in CI/npm):
pytest test/backfill_sessions_test.py -v
```

### Patterns

| Pattern | Notes |
|---------|-------|
| `mockKV()` / `mockSdk()` | In-memory Map KV + registerFunction/trigger; often defined locally (see also `test/helpers/mocks.ts`) |
| `vi.mock("../src/logger.js")` | Suppress log noise |
| Real modules under test | Prefer arg-injected mocks over mocking the SUT |
| `describe` → `it` | Named after behavior; issue refs in titles when relevant (`#775`) |
| Integration | Real `fetch` to running daemon; fails fast if `/livez` down |

### Benchmarks & Eval

| Area | Entry | Needs daemon? |
|------|-------|---------------|
| Load | `npm run bench:load` → `benchmark/load-100k.ts` | Yes |
| Offline quality | `benchmark/quality-eval.ts` + `dataset.ts` | No |
| LongMemEval | `npm run eval:longmemeval` | Adapter-dependent |
| Coding-life | `npm run eval:coding-life` | Adapter-dependent |

Eval adapters (`eval/runner/adapters/`): `grep`, `vector` (OpenAI), `agentmemory`. Sandbox helper: `eval/scripts/sandbox.sh` (clean ports 3411/3412).

### CI

- Matrix: ubuntu + macos × Node 20 + 22; `fail-fast: false`
- Steps: install → `npm run build` → `npm run skills:check` → `npm test`
- No Windows, no integration suite, no coverage gate
- `scripts/check-env-example.mjs` keeps `.env.example` in sync with `AGENTMEMORY_*` usage

### Skills QA

- `npm run skills:gen` — autogen `REFERENCE.md` blocks from tools-registry, API paths, env, hooks
- `npm run skills:check` — frontmatter, “Use when”, ≤100 lines, plugin skill count match
- 8 invocable skills (handoff, recall, recap, remember, session-history, commit-context, commit-history, forget) + 7 reference skills

---

## Agent Orientation Shortcuts

| Need | Go to |
|------|--------|
| Install yourself on a user machine | `INSTALL_FOR_AGENTS.md` |
| Short gotchas | `CLAUDE.md` |
| Deep system design | `docs/architecture.md` |
| Known production pain | `docs/known-issues.md` |
| User API/docs | `README.md` |
| Live install broken | `bash scripts/status.sh` |
| Memory not saved / dupes | `src/functions/observe.ts` + dedup |
| New MCP tool | consistency checklist above |
| Website/visual work only | `DESIGN.md` + `website/` |
