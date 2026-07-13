# Agent coding conventions

> **Audience**: coding agents and contributors changing engine code.  
> **Loaded when**: implementing features, adding tools/endpoints, or fixing multi-file sync.  
> **Entrypoint**: root [`AGENTS.md`](../AGENTS.md) (always-on rules + index).

## Architecture (short)

Full diagrams and process model: [`architecture.md`](./architecture.md).

**agentmemory** is a CLI daemon (not an importable app library). It runs as an [iii-engine](https://iii.dev) worker: Node on REST port `3111`, captures tool calls via hooks, stores SQLite-backed KV via iii `StateModule`, serves hybrid search (BM25 + Vector + Graph, RRF).

### Three primitives (never bypassed)

All state changes go through iii-engine primitives — no Express/Fastify, no direct SQLite from handlers:

1. `sdk.registerFunction("mem::<name>", handler)` — callable function  
2. `sdk.registerTrigger({ type: "http" | "event", function_id, config })` — bind routes  
3. `sdk.trigger({ function_id, payload })` — internal invoke  

Namespaces: `mem::` (core), `api::` (REST), `event::` (subscribers), `mcp::`, `middleware::` (auth).

### Hook → REST → worker

```
Agent Hook Script (plugin/scripts/<hook>.mjs  ← built from src/hooks/*.ts)
  └─ fetch POST /agentmemory/{observe,session/*,...}
      └─ iii-engine HTTP trigger → api::<name>
          └─ sdk.trigger({ function_id: "mem::<name>", payload })
              └─ src/functions/<name>.ts
                  ├─ privacy filter
                  ├─ SHA-256 fingerprint dedup (5min window)
                  ├─ kv.set(KV.<scope>(key), data)
                  └─ (opt) compress / embed → index update
```

### Search

| Leg | Mechanism | Default |
|-----|-----------|---------|
| BM25 | Inverted index + stemmer/synonym/CJK | Built-in |
| Vector | Float32 cosine | all-MiniLM-L6-v2 (384d, local) |
| Graph | Concept nodes + typed edges | Built-in |

Fusion: RRF (k=60) → cross-encoder reranker (`Xenova/ms-marco`) → session diversity → KV enrichment.

### Bootstrap (`src/index.ts`)

1. Config / embedding + fallback  
2. Providers → `ResilientProvider`  
3. `registerWorker(sdk)` → WebSocket to iii-engine  
4. `StateKV` → sole persistence bridge  
5. Search globals; register `mem::*` + API/event/MCP triggers  
6. Periodic timers (all `.unref()` + `_cleanupTimers[]`)  
7. Index load/rebuild; viewer on `REST_PORT + 2`  
8. SIGINT/SIGTERM shutdown  

### Key directories

| Path | Purpose |
|------|---------|
| `src/index.ts` | Worker bootstrap; **register new functions here** |
| `src/functions/` | One module per `mem::*` handler |
| `src/state/` | StateKV, schema, BM25, vectors, hybrid, dedup, mutex |
| `src/triggers/` | REST (`api.ts`), session events |
| `src/mcp/` | MCP server, tools-registry, standalone stdio |
| `src/hooks/` | Lifecycle hooks → `plugin/scripts/` + `dist/hooks/` |
| `src/providers/` | LLM + embedding providers |
| `src/cli/` + `src/cli.ts` | CLI adapters |
| `src/prompts/` | LLM templates |
| `src/viewer/` | Dashboard (rest+2) |
| `test/` | Vitest unit files (flat) |
| `integrations/` | Host plugins (omp/pi/hermes/openclaw/…); **not imported by engine** |
| `plugin/` | Manifests, hooks configs, skills, bundled scripts |
| `scripts/` | Ops + skills gen/check |
| `benchmark/`, `eval/` | Load/quality benches |
| `deploy/` | fly / railway / render / coolify |
| `docs/` | This tree — start at [`README.md`](./README.md) |
| `website/` | Marketing site; visual system in root `DESIGN.md` only |

## Typing & language

- TypeScript **strict**, ESM only (`"type": "module"`), ES2022, `moduleResolution: bundler`  
- Source imports use `.js` extensions for `.ts` files  
- Prefer clear names over restating comments  
- IDs: `fingerprintId()` (content hash), `generateId()`  
- Capture timestamps once: `const now = new Date().toISOString()`

## Function registration

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

Handlers return `{ success, error?, skipped?, ... }`. Register from `src/index.ts`.

## REST endpoint

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

## MCP tool handler

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

Schemas live in versioned arrays in `tools-registry.ts`. `AGENTMEMORY_TOOLS=core|all` (default **all**).

## Hook script patterns

Standalone Node (no iii-sdk). Read JSON stdin → POST REST → exit.

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

## State & search

- **StateKV only** — never touch `data/state_store.db` directly  
- KV scopes in `src/state/schema.ts`; unknown scopes rejected  
- BM25 + vector indexes in-memory; after mutations `scheduleIndexSave()` / `flushIndexSave()`  
- Concurrent scope writes: `withKeyedLock`  
- Embeddings: `withDimensionGuard` against silent corruption  

## Error handling & async

- Boundary validation: inline `typeof` guards; Zod in eval paths  
- Provider chain: base → Resilient → optional Fallback + CircuitBreaker  
- Fire-and-forget: `sdk.trigger({ …, action: TriggerAction.Void() })` — **never** `action: "void"` (string blocks event loop)  
- `setInterval` must `.unref()` and join `_cleanupTimers[]`  

## Audit

- `recordAudit(kv, operation, functionId, targetIds, details)` → `KV.audit`  
- `safeAudit()` for fire-and-forget  
- Scoped delete: one row per call; bulk: one batched row with count  

## MCP dual mode

- **REST mode**: `registerMcpEndpoints()` on worker  
- **Standalone**: `standalone.ts` stdio; probes daemon via `rest-proxy.ts`, else `InMemoryKV`  

## Consistency checklists

**Adding/removing MCP tools:**

1. `src/mcp/tools-registry.ts` — definition + `getAllTools()`  
2. `src/mcp/server.ts` — `mcp::tools::call` switch  
3. `src/triggers/api.ts` — REST if exposed  
4. `src/index.ts` — registration + boot log tool count  
5. `test/mcp-standalone.test.ts` — count/name assertions  
6. `README.md` — advertised counts  
7. `plugin/.claude-plugin/plugin.json` / `plugin/plugin.json` / `plugin/.mcp.copilot.json`  

**Adding REST endpoints:**

1. `src/triggers/api.ts`  
2. `src/index.ts` boot log endpoint count  
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

**After changing hooks:** `npm run build` (both hook trees).  

**After changing tools/API/env:** `npm run skills:gen` && `npm run skills:check`.

## Important files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry |
| `src/cli.ts` | CLI binary |
| `src/config.ts` | `~/.agentmemory/.env` + env flags |
| `src/types.ts` | Domain interfaces |
| `src/state/schema.ts` | KV/STREAM constants |
| `src/state/kv.ts` | StateKV |
| `src/state/hybrid-search.ts` | RRF fusion |
| `src/functions/observe.ts` | Highest-traffic ingest |
| `src/functions/search.ts` | Index singletons / rebuild |
| `src/triggers/api.ts` | REST registrations |
| `src/mcp/tools-registry.ts` | Tool schemas |
| `src/version.ts` | `VERSION` |
| `iii-config.yaml` / `iii-config.docker.yaml` | Engine workers/ports |
| `.env.example` | Canonical env docs (CI-checked) |
| `tsdown.config.ts` | Multi-entry ESM build |
| `INSTALL_FOR_AGENTS.md` | Agent self-install runbook |

## Runtime / tooling preferences

| Aspect | Choice |
|--------|--------|
| Runtime | **Node.js** ≥20 (not Bun/Deno) |
| Package manager | **npm** (lockfiles may be gitignored; CI may regenerate via `npm install --package-lock-only` then `npm ci --legacy-peer-deps`) |
| Build | **tsdown** (ESM, node20) |
| Dev runner | **tsx** |
| TypeScript | v6, strict, `noUnusedLocals` / `noUnusedParameters` |
| Tests | **vitest** |
| Lint/format | TypeScript strict only |
| CI | build + `skills:check` + unit tests |

### Dependency rules

**Allowed runtime:** `iii-sdk@0.11.2`, `zod`, `dotenv`, `picocolors`, `@clack/prompts`, `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`.

**Optional** (embeddings / CJK / CLIP): `@xenova/transformers`, `onnxruntime-*`, `@node-rs/jieba`, `tiny-segmenter`.

**Do not add:** Express, Fastify, pg, redis, mongoose, standalone SQLite ORMs.

### Config surface

Config merges `~/.agentmemory/.env` over `process.env`. See `.env.example` for full list (LLM keys, embeddings, `AGENTMEMORY_SECRET`, search weights, feature flags, ports, `AGENTMEMORY_TOOLS`, `AGENTMEMORY_III_VERSION`).

Docker: `iiidev/iii:0.11.2`, ports 3111/3112/9464; deploy templates generate HMAC secret on first boot.

## What not to do

- Don't bypass iii primitives or write `data/state_store.db` directly  
- Don't hand-edit `dist/`, `dist/hooks/`, or `plugin/scripts/`  
- Don't bump `iii-sdk` past `0.11.2` without the sandbox refactor  
- Don't pass raw request bodies into `sdk.trigger()`  
- Don't use `action: "void"` — use `TriggerAction.Void()`  
- Don't leave `setInterval` without `.unref()` / `_cleanupTimers`  
- Don't assume integrations share code with `src/` — they HTTP-call the daemon independently  

## Multi-file gotchas

- **Tool counts** must stay in sync: boot log, `test/mcp-standalone.test.ts`, README, plugin manifests  
- **`TriggerAction` is a discriminated union**, not a string  
- Hooks bundled **twice** (`plugin/scripts/` + `dist/hooks/`)  
- `AGENTMEMORY_URL` / `AGENTMEMORY_SECRET` propagate parent shell → hooks → MCP  
- Engine binary pin **v0.11.2**; v0.11.6+ sandbox model not adopted yet  
- OMP/pi/openclaw under `integrations/` are host-loaded; known duplication wart in `docs/issues/`  

## Build outputs (do not hand-edit)

| Output | Source |
|--------|--------|
| `dist/index.mjs` + `.d.mts` | `src/index.ts` |
| `dist/cli.mjs` | `src/cli.ts` |
| `dist/standalone.mjs` | `src/mcp/standalone.ts` |
| `dist/hooks/*.mjs` | `src/hooks/*.ts` |
| `plugin/scripts/*.mjs` | `src/hooks/*.ts` |
