# Repository Guidelines

## Project Overview

**agentmemory** — persistent memory for AI coding agents (Claude Code, Codex, Cursor, OpenCode, pi, OMP, Hermes, and 15+ others). Runs as an [iii-engine](https://iii.dev) worker: a single Node.js process on port `3111` that captures tool calls via agent-specific hooks, stores them in a SQLite-backed KV store (via iii-engine's `StateModule`), and serves hybrid search (BM25 + Vector + Graph, fused via RRF).

- **Package**: `@agentmemory/agentmemory` (npm)
- **Version**: `0.9.27`
- **License**: Apache-2.0
- **Node**: `>=20.0.0`
- **Engine pin**: `iii-sdk@0.11.2` — do not upgrade past v0.11.2 until the sandbox (v0.11.6+) refactor lands
- **Key stats**: 53 MCP tools, 129 REST endpoints, 12 hooks, 15 skills, 70+ `mem::*` functions, 1423+ tests, 12 translated READMEs

---

## Architecture & Data Flow

### Three Primitives (never bypassed)

All state changes go through iii-engine's three primitives — no Express, no Fastify, no direct SQLite:

1. `sdk.registerFunction("mem::<name>", handler)` — define a callable function
2. `sdk.registerTrigger({ type: "http" | "event", function_id, config })` — bind HTTP / event routes to functions
3. `sdk.trigger({ function_id, payload })` — invoke a function (internal cross-call)

### Hook → REST → Worker Flow

```
Agent Hook Script (plugin/scripts/<hook>.mjs)
  └─ fetch POST /agentmemory/{observe,session/*,...}
      └─ iii-engine HTTP trigger → api::<name> handler
          └─ sdk.trigger({ function_id: "mem::<name>", payload })
              └─ src/functions/<name>.ts handler
                  ├─ privacy filter (strip secrets)
                  ├─ SHA-256 fingerprint dedup (5min window)
                  ├─ kv.set(KV.<scope>(key), data)
                  └─ (opt) sdk.trigger mem::embed → vector index update
```

### Search Architecture — TripleStream + RRF

Hybrid search fuses three parallel retrieval legs:

| Leg | Mechanism | Default Model |
|-----|-----------|---------------|
| BM25 | Inverted index with stemmer/synonym/CJK (k1=1.2, b=0.75) | Built-in |
| Vector | Float32Array embeddings, cosine similarity | all-MiniLM-L6-v2 (384d, local, no API key) |
| Graph | Knowledge graph traversal (concept nodes + typed edges) | Built-in |

Fusion: RRF (k=60) → cross-encoder reranker (Xenova/ms-marco) → session diversity filter → KV enrichment.

Benchmarks: 95.2% R@5, 98.6% R@10 on LongMemEval (hybrid). BM25 alone: 86.2% R@5. Token reduction vs grep: 86-92%.

### Bootstrap Sequence (`src/index.ts`)

1. `loadConfig()` / `loadEmbeddingConfig()` / `loadFallbackConfig()`
2. `createProvider` / `createFallbackProvider` → `ResilientProvider`
3. `createEmbeddingProvider` / `createImageEmbeddingProvider`
4. `registerWorker(sdk)` → connect to iii-engine via WebSocket
5. `new StateKV(sdk)` → KV bridge
6. Set up globals in `src/functions/search.ts` (vector index, embedding provider)
7. `initMetrics()` → OTEL meter
8. Register ~50 function handlers (privacy, observe, compress, remember, search, ...)
9. Periodic timers (auto-forget, evict, consolidation, decay sweeps) — all `.unref()` and in `_cleanupTimers[]`
10. `HybridSearch` init → `IndexPersistence.load()` → rebuild index if stale
11. `startViewerServer()` → web dashboard (port `REST_PORT + 2`)
12. Shutdown handler (SIGINT/SIGTERM)

---

## Key Directories

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker bootstrap (~600 lines). Registers all `mem::*` functions. Add new function registrations here. |
| `src/functions/` | 70+ files, one per `mem::<name>` handler. Each exports `register<Name>(sdk, kv, ...)`. |
| `src/state/` | KV adapter (`kv.ts`), KV scopes (`schema.ts` — 70+ `mem:*` prefixes), BM25 (`search-index.ts`), vector index (`vector-index.ts`), hybrid fusion (`hybrid-search.ts`), reranker (`reranker.ts`), dedup (`dedup.ts`), index persistence (`index-persistence.ts`), keyed mutex (`keyed-mutex.ts`), stemmer/synonyms/CJK segmenter. |
| `src/mcp/` | MCP server (`server.ts` — REST-route-based), tool registry (`tools-registry.ts` — 10+ version tiers), standalone stdio MCP (`standalone.ts`), JSON-RPC transport (`transport.ts`), REST proxy (`rest-proxy.ts`), in-memory KV fallback (`in-memory-kv.ts`). |
| `src/hooks/` | 13 standalone Node.js hook scripts. Bundled to both `plugin/scripts/` and `dist/hooks/` by tsdown. |
| `src/triggers/` | HTTP triggers (`api.ts` — 129 endpoints) + event triggers (`events.ts` — session lifecycle). |
| `src/providers/` | LLM providers (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, agent-sdk, noop) + embedding providers (local, OpenAI, Voyage, Cohere, Gemini, CLIP). Factory + `ResilientProvider` + `FallbackChainProvider` wrappers. |
| `src/cli/` | CLI entry (`cli.ts` — start/stop/status/doctor/init/...) + diagnostics, onboarding, splash, `connect/` platform catalog (20+ agent config generators). |
| `src/health/` | Health monitor — CPU/mem/event-loop/KV probe. |
| `src/eval/` | Evaluation infrastructure: metrics store, quality scoring, Zod validators, self-correction. |
| `src/telemetry/` | OTEL setup: 15 counters, 8 histograms. |
| `src/prompts/` | LLM prompt templates (compression, consolidation, graph extraction, reflect, summary, vision, XML). |
| `src/viewer/` | Web dashboard with CSP/CORS/Host validation. |
| `test/` | 131 test files (`.test.ts`). Flat structure. |
| `integrations/` | Per-agent extensions: `omp/` (Oh My Pi), `pi/`, `openclaw/`, `hermes/` (Python), `filesystem-watcher/`. Each has own `package.json` — engine never imports them. |
| `plugin/` | Claude Code / Codex / Copilot manifests, 15 skills, hook configs, OpenCode capture plugin (25KB). |
| `website/` | Next.js 16 App Router landing (18 components, CSS Modules, Vercel-deployed). |
| `scripts/` | Python backfill (`backfill-sessions.py`), shell backup (`agentmemory-backup.sh`), skill generation, env validation. |
| `deploy/` | Deploy templates (fly.io, railway, render, coolify). Multi-stage Dockerfiles. |
| `benchmark/` | Load test, quality eval, LongMemEval runner, dataset generator. Results in `benchmark/results/`. |
| `eval/` | Evaluation harness (adapter pattern — grep, vector, agentmemory). LongMemEval + in-house coding-life. |

---

## Development Commands

```bash
npm install                # One-time setup; pulls iii-engine binary on first run
npm run dev                # Hot-reload: tsx src/index.ts
npm run build              # Production: tsdown → dist/, copies configs + viewer
npm test                   # vitest run (1423+ tests, excludes test/integration.test.ts)
npm run test:watch         # vitest watch mode
npm run test:integration   # Integration suite (requires running daemon at localhost:3111)
npm run test:all           # Unit + integration
npm run skills:gen         # Generate skill content from MCP tool registry
npm run skills:check       # Validate skill structure + CI drift check
npm run eval:longmemeval   # Run LongMemEval benchmark
npm run eval:coding-life   # Run in-house benchmark

# Single test
npx vitest run test/observe.test.ts
npx vitest run test/observe.test.ts -t "should dedup"
npx vitest watch test/smart-search.test.ts
```

### Build outputs

`npm run build` produces (do NOT hand-edit these):

| Output | Source | Purpose |
|--------|--------|---------|
| `dist/index.mjs` + `.d.mts` | `src/index.ts` | npm-published worker bundle |
| `dist/cli.mjs` | `src/cli.ts` | CLI binary (`agentmemory`) |
| `dist/standalone.mjs` | `src/mcp/standalone.ts` | Standalone MCP server |
| `dist/hooks/*.mjs` | `src/hooks/*.ts` | Hook scripts for npm users |
| `plugin/scripts/*.mjs` | `src/hooks/*.ts` | Hook scripts for plugin users |

---

## Code Conventions & Common Patterns

### Typing & Language
- **TypeScript strict mode**, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- `fingerprintId()` for content-addressable dedup (SHA-256), `generateId()` for unique IDs
- Timestamps: capture once with `new Date().toISOString()` and reuse

### Function Registration

```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { sessionId: string; ... }) => {
    if (!data?.sessionId || typeof data.sessionId !== "string") {
      return { success: false, error: "sessionId required" };
    }
    await kv.set(KV.observations(data.sessionId), observation);
    await recordAudit(kv, "create", "mem::your-function", [data.sessionId]);
    return { success: true, ... };
  },
);
```

### REST Endpoint

```typescript
sdk.registerFunction("api::your-endpoint", async (req: ApiRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  // NEVER pass raw request body to sdk.trigger() — whitelist fields
  const body = req.body as Record<string, unknown>;
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { sessionId: body.sessionId, ... },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

### MCP Tool Handler

```typescript
case "memory_your_tool": {
  // validate with typeof; parse CSV with .split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Hook Script Patterns

Standalone Node.js scripts (no iii-sdk import). Two modes:

**Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`):
```typescript
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  // write context to stdout for agent prompt injection
} catch (e) {
  process.stderr.write(`hook error: ${e}\n`);
}
```

**Fire-and-forget hooks** (`post-tool-use`, `notification`, `stop`, `session-end`, ...):
```typescript
fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => {});
setTimeout(() => process.exit(0), 500).unref();  // 1500ms for multi-request hooks
```

### Input Validation
- Inline type guards at system boundaries (MCP handlers, REST endpoints, `mem::*` handlers)
- Zod schemas via `src/eval/validator.ts` for eval paths
- REST endpoints must NEVER pass raw request body to `sdk.trigger()` — whitelist fields

### Concurrency
- `Promise.all` for independent KV writes/reads
- `withKeyedLock(key, fn)` from `state/keyed-mutex.ts` for per-key critical sections (e.g., observation writes keyed on `sessionId`)

### Audit Logging
- `recordAudit(kv, operation, functionId, targetIds, details)` — creates `AuditEntry` in `KV.audit`
- `safeAudit()` — fire-and-forget wrapper
- Scoped deletions: one row per call with `targetIds[]`; bulk sweeps: one batched row with count

### Provider Architecture
- Factory (`providers/index.ts`): `createBaseProvider(config)` → concrete provider
- Wrapped in `ResilientProvider` (retry + circuit breaker)
- Optionally wrapped in `FallbackChainProvider` (ordered fallback across providers)
- Embedding providers wrapped in `withDimensionGuard` for output dimension validation

### Timer Lifecycle
`setInterval` timers MUST call `.unref()` and be added to `_cleanupTimers[]` for `clearInterval` on shutdown.

### MCP Dual Mode
- **REST mode**: `registerMcpEndpoints()` registers API routes on the iii-sdk
- **Standalone mode**: `standalone.ts` runs stdio JSON-RPC 2.0, probes daemon via `rest-proxy.ts` — proxies if reachable, uses local `InMemoryKV` otherwise

### iii-sdk `TriggerAction` Is a Discriminated Union
Use `TriggerAction.Void()` for fire-and-forget, never `action: "void"` (a bare string). The runtime checks `action?.type`; a bare string falls into the sync branch and blocks the event loop.

### Consistency Checklists

**Adding/removing MCP tools:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint
4. `src/index.ts` — function registration + endpoint count log line
5. `test/mcp-standalone.test.ts` — tool count assertion
6. `README.md` — tool counts
7. `plugin/.claude-plugin/plugin.json` — tool count in description
8. `plugin/plugin.json` / `plugin/.mcp.copilot.json` — MCP exposure

**Adding REST endpoints:**
1. `src/triggers/api.ts` — endpoint registration
2. `src/index.ts` — endpoint count log line
3. `README.md` — endpoint counts

**Bumping version:**
1. `package.json` — version
2. `src/version.ts` — VERSION constant + type union
3. `src/types.ts` — ExportData version union
4. `src/functions/export-import.ts` — supportedVersions set
5. `test/export-import.test.ts` — version assertion
6. `plugin/.claude-plugin/plugin.json` — version
7. `plugin/plugin.json` — version

**Adding KV scopes:**
1. `src/state/schema.ts` — add to KV object
2. `src/types.ts` — add interface

**Adding audit operations:**
1. `src/types.ts` — add to `AuditEntry.operation` union

---

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker bootstrap (~600 lines). Entry point for all builds. Registers 50+ functions, timers, viewer. |
| `src/config.ts` | Env-based config loader. Reads `~/.agentmemory/.env` then `process.env`. Feature flags: `isAutoCompressEnabled`, `isContextInjectionEnabled`, `isConsolidationEnabled`, `isGraphExtractionEnabled`, `isStandaloneMcp`. |
| `src/types.ts` | ~950 lines, 60+ interfaces across all domains (data models, providers, search, graph, consolidation, orchestration, multi-agent, operations). |
| `src/state/schema.ts` | KV scope constants (70+ `mem:*` prefixes), `generateId()`, `fingerprintId()`, `jaccardSimilarity()`. |
| `src/version.ts` | `VERSION = "0.9.27"` + `ValidVersion` type union for export-import guards. |
| `.env.example` | 14-section env var reference: LLM/embedding provider selection, auth, search tuning, behavior flags, ports, engine pin. |
| `src/functions/observe.ts` | Most-trafficked handler — start here when debugging "memory not being saved". |
| `src/functions/diagnostics.ts` | 36KB health diagnostics engine powering the viewer diagnostics dashboard. |
| `src/functions/search.ts` | Exports global BM25/vector index references (`getSearchIndex()`, `setVectorIndex()`, `rebuildIndex()`). |
| `iii-config.yaml` | Engine config: http port 3111, state/stream adapters, worker roles, 180s timeout. |
| `src/mcp/tools-registry.ts` | Tool definitions across 10+ version tiers, `getAllTools()`, `getVisibleTools()`. |

---

## Runtime / Tooling Preferences

| Aspect | Choice |
|--------|--------|
| Runtime | **Node.js** >=20.0.0 (not Bun, not Deno) |
| Package manager | **npm** (lockfile intentionally NOT checked in) |
| Build | **tsdown** v0.21.10 (ESM-only, target node20) |
| Run dev | **tsx** (TypeScript executor) |
| TypeScript | **v6.0.3**, strict, `ES2022`, `moduleResolution: bundler` |
| Test | **vitest** v4.1.6, no config file (defaults: `**/*.test.ts` glob, Node env) |
| Linting | TypeScript strict mode + `noUnusedLocals`/`noUnusedParameters` — no eslint/prettier |
| CI | GitHub Actions (ubuntu + macos × Node 20 + 22) |
| Publishing | GitHub release → npm publish (3 packages) with Sigstore provenance |

### Dependency Rules

**Runtime deps** (all in `package.json`):
- `iii-sdk@0.11.2` — the engine (pinned, do not upgrade)
- `zod@^4.0.0` — schema validation
- `dotenv` / `picocolors` / `@clack/prompts` — CLI/UI
- `@anthropic-ai/sdk` / `@anthropic-ai/claude-agent-sdk` — LLM providers

**Do NOT add** Express, Fastify, pg, redis, mongoose, or standalone-SQLite-ORM. iii-engine replaces them.

**Optional deps** (user-installed for local embeddings / CJK / CLIP):
- `@xenova/transformers`, `onnxruntime-node`, `onnxruntime-web`, `@node-rs/jieba`, `tiny-segmenter`

**Dev deps**: `vitest`, `tsdown`, `tsx`, `typescript`

**Security overrides**: `qs`, `ws`, `protobufjs` (pinned via `overrides`)

### Config Source

`~/.agentmemory/.env` layered over `process.env`. Call-time `overrides` argument wins all.

Key env var categories (see `.env.example` for full reference):
- LLM: `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` | ...
- Embedding: `EMBEDDING_PROVIDER=local|openai|voyage|cohere|gemini|openrouter`
- Auth: `AGENTMEMORY_SECRET=<bearer-token>`
- Search: `BM25_WEIGHT=0.4` `VECTOR_WEIGHT=0.6` `TOKEN_BUDGET=2000`
- Features: `AGENTMEMORY_AUTO_COMPRESS=true` `GRAPH_EXTRACTION_ENABLED=true`
- Ports: `III_REST_PORT=3111` `III_ENGINE_URL=ws://localhost:49134`
- Tools surface: `AGENTMEMORY_TOOLS=core|all`

### What Not To Do
- Don't add Express / Fastify / pg / redis / mongoose — iii-engine replaces them
- Don't add new top-level deps without checking package.json
- Don't bypass iii by writing to `data/state_store.db` directly — always go through `kv.*`
- Don't hand-edit `dist/`, `dist/hooks/`, or `plugin/scripts/` — regenerated by `npm run build`
- Don't bump `iii-sdk` past 0.11.2 without verifying the sandbox refactor

---

## Testing & QA

### Test Framework
- **Vitest** v4.1.6 — no config file (default glob `**/*.test.ts`, Node environment)
- 131 TypeScript test files in `test/` (flat, no subdirectories)
- 1 Python test (`backfill-ts-key.test.py`) for `scripts/backfill-sessions.py`

### Running Tests
```bash
npm test                    # 1423+ tests (excludes integration)
npx vitest run test/<name>  # Single file
npx vitest watch test/<name> -t "should"  # Watch + filter by name
npm run test:integration    # Requires running daemon at localhost:3111
```

### Mock Patterns

| Mock | Purpose | Usage |
|------|---------|-------|
| `vi.mock("iii-sdk")` | Mock iii-engine | `mockSdk()` returns `{ registerFunction, trigger: vi.fn() }` |
| `mockKV()` | In-memory Map-based KV | Implements `get/set/delete/list` — never hits real state layer |
| `vi.mock("../src/logger.js")` | Suppress logger noise | 68/131 tests use this |
| `vi.spyOn(globalThis, 'fetch')` | Mock HTTP calls | Embedding providers, MCP proxy, viewer, mesh |
| `process.env` manipulation | Set/clear env vars | 33 tests; backup/restore in `afterEach` |
| `mkdtempSync` | Temp directories | Export-import, replay, hook-project, compress-file |

### Test Structure
- Files import `register<Name>`, pass mock SDK + KV, invoke via `sdk.trigger('mem::<name>', payload)`
- Return values cast inline: `as { success: boolean; error: string }`
- No test runs against a real iii-engine (except integration tests)
- Test names reference issue numbers: `'re-imports a session whose stored row is missing the id field without aborting the batch (#775)'`
- Total assertions across all tests: ~3581 (`toBe`, `toEqual`, `toContain`, `toMatch`, `rejects.toThrow`, etc.)

### Integration Tests
- `test/integration.test.ts` — excluded from `npm test`
- Requires `AGENTMEMORY_URL` (default `http://localhost:3111`) pointing to a running daemon
- Real HTTP `fetch()` calls to REST API

### CI
- `ci.yml`: ubuntu + macos × Node 20 + 22 — build, skills:check, test
- `publish.yml`: GitHub release → npm publish (3 packages with Sigstore provenance)
- Dependabot: weekly Monday, 6 ecosystems, grouped minor+patch

### Coverage
- No coverage threshold configured (no vitest config file)
- Many error-path tests (missing IDs, bad shapes, blocked operations, concurrency)