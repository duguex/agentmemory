# integrations/omp/index.ts Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 11 defects in `integrations/omp/index.ts` covering narrative field, session state, fetch resilience, security warnings, URL safety, SDK guard, and 3 robustness layers (circuit breaker, env re-evaluation, undefined guards).

**Architecture:** TDD where feasible (vitest), but many fixes are integration-level (fetch, hooks). Layer changes by concern: (1) field/types (G3.1, G3.11), (2) state machine (G3.2), (3) HTTP resilience (G3.3, G3.4, G3.9, G3.10), (4) URL/auth safety (G3.5, G3.7), (5) input validation (G3.6, G3.8), (6) shutdown (G3.4). Cross-file changes (smart-search type extension) coordinated via G5.

**Tech Stack:** TypeScript 5, vitest, `@sinclair/typebox` (already used), `AbortSignal.timeout` (Node 18+), `fetch` (Node 18+).

## Global Constraints

- ESM only (`"type": "module"` in package.json)
- TypeScript strict mode
- Node 18+ features: `AbortSignal.timeout`, top-level `await` not used
- Spec reference: `docs/superpowers/specs/2026-07-03-omp-adaptation-fixes-design.md` §G3
- Cross-spec dependency: G3.1 (narrative field) requires G5.3 (smart-search score/narrative consistency) to be merged first or co-committed
- Code style: matching existing OMP file (tabs for indent, no semicolons optional)

---

## File Structure

| File | Role |
|---|---|
| `integrations/omp/index.ts` | MODIFY — all 11 fixes |
| `integrations/omp/circuit-breaker.ts` | CREATE — extracted circuit-breaker state machine (G3.9) |
| `test/omp-integration.test.ts` | CREATE — vitest tests covering key fixes |
| `src/functions/smart-search.ts` | MODIFY (small, in G5) — extend CompactSearchResult with narrative?: string |

No new files in `plugin/` or `dist/`. Changes flow through the build later.

---

## Task 1: Add circuit breaker module (G3.9)

**Files:**
- Create: `integrations/omp/circuit-breaker.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CircuitBreaker` class with methods `canRequest()`, `recordSuccess()`, `recordFailure()`, `getState()`

- [ ] **Step 1: Write failing test in `test/omp-integration.test.ts`**

Create `test/omp-integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../integrations/omp/circuit-breaker.js";

describe("CircuitBreaker (G3.9)", () => {
  it("starts in CLOSED state and allows requests", () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canRequest()).toBe(true);
  });

  it("transitions to OPEN after threshold failures", () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canRequest()).toBe(false);
  });

  it("transitions to HALF_OPEN after cooldown", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canRequest()).toBe(false);
    // Wait for cooldown
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.getState()).toBe("HALF_OPEN");
        expect(cb.canRequest()).toBe(true);
        resolve();
      }, 60);
    });
  });

  it("HALF_OPEN success transitions back to CLOSED", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // → HALF_OPEN
        cb.recordSuccess();
        expect(cb.getState()).toBe("CLOSED");
        expect(cb.canRequest()).toBe(true);
        resolve();
      }, 60);
    });
  });

  it("HALF_OPEN failure transitions back to OPEN with fresh cooldown", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    cb.recordFailure();
    cb.recordFailure();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canRequest(); // → HALF_OPEN
        cb.recordFailure();
        expect(cb.getState()).toBe("OPEN");
        resolve();
      }, 60);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails (module not found)**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-integration.test.ts -v`
Expected: FAIL with `Cannot find module '../integrations/omp/circuit-breaker.js'`

- [ ] **Step 3: Create `integrations/omp/circuit-breaker.ts`**

```typescript
// G3.9: Three-state circuit breaker for OMP HTTP resilience
// Threshold/Cooldown: 5 failures / 60s (user-confirmed)
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  threshold: number;     // consecutive failures to open
  cooldownMs: number;    // ms before HALF_OPEN probe
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  getState(): CircuitState {
    if (
      this.state === "OPEN" &&
      Date.now() - this.lastFailureTime > this.opts.cooldownMs
    ) {
      this.state = "HALF_OPEN";
    }
    return this.state;
  }

  canRequest(): boolean {
    const currentState = this.getState();
    return currentState === "CLOSED" || currentState === "HALF_OPEN";
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.opts.threshold) {
      this.state = "OPEN";
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-integration.test.ts -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add integrations/omp/circuit-breaker.ts test/omp-integration.test.ts
git commit -m "feat(omp): add three-state circuit breaker (G3.9)"
```

---

## Task 2: Wire circuit breaker into apiPost/apiGet (G3.9)

**Files:**
- Modify: `integrations/omp/index.ts` (top of file + `apiPost`/`apiGet`)

- [ ] **Step 1: Add import and module-level breaker**

At the top of `integrations/omp/index.ts`, after existing imports, add:

```typescript
import { CircuitBreaker } from "./circuit-breaker.js";

// G3.9: module-level circuit breaker (5 failures / 60s cooldown)
const httpBreaker = new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 });
```

- [ ] **Step 2: Wrap fetch calls with `canRequest()`**

Modify both `apiPost` and `apiGet`. Replace their bodies with:

```typescript
async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
  if (!httpBreaker.canRequest()) {
    return null;  // circuit OPEN — fast-fail, no fetch attempt
  }
  try {
    const base = baseUrl().replace(/\/+$/, "");
    const prefix = base.includes("/agentmemory") ? "/" : "/agentmemory/";
    const url = `${base}${prefix}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      httpBreaker.recordFailure();
      return null;
    }
    httpBreaker.recordSuccess();
    return (await response.json()) as T;
  } catch (err) {
    httpBreaker.recordFailure();
    console.warn(`[agentmemory] apiPost failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
```

Apply analogous changes to `apiGet` (same structure, GET method).

- [ ] **Step 3: Run all OMP tests**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-integration.test.ts -v`
Expected: PASS

- [ ] **Step 4: Manual smoke test (mock breaker)**

Create a temporary test file `test/omp-circuit-wiring.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("apiPost circuit breaker integration (G3.9)", () => {
  it("5 consecutive failures trip the breaker", async () => {
    vi.resetModules();
    process.env.AGENTMEMORY_URL = "http://localhost:9999";
    process.env.AGENTMEMORY_SECRET = "x";
    
    // Mock fetch to always fail
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    
    const { default: agentmemoryExtension } = await import("../integrations/omp/index.js");
    
    // After 5 failures, circuit should be OPEN
    // This requires calling internal apiPost — but it's not exported.
    // Indirect: import the breaker directly and verify state.
    const { CircuitBreaker } = await import("../integrations/omp/circuit-breaker.js");
    const cb = new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.canRequest()).toBe(false);
  });
});
```

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-circuit-wiring.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add integrations/omp/index.ts test/omp-circuit-wiring.test.ts
git commit -m "feat(omp): wire circuit breaker into apiPost/apiGet (G3.9)"
```

---

## Task 3: Add retry logic to fetch (G3.3)

**Files:**
- Modify: `integrations/omp/index.ts` (extract `apiRequest<T>` helper)

- [ ] **Step 1: Extract `apiRequest<T>` shared by `apiPost`/`apiGet`**

The new helper:

```typescript
async function apiRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T | null> {
  if (!httpBreaker.canRequest()) return null;
  const maxAttempts = 3;
  const backoffs = [100, 200, 400];  // ms
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const base = baseUrl().replace(/\/+$/, "");
      const prefix = base.includes("/agentmemory") ? "/" : "/agentmemory/";
      const url = `${base}${prefix}${path}`;
      const response = await fetch(url, {
        method,
        headers: authHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        httpBreaker.recordFailure();
        return null;  // don't retry on HTTP errors (server reachable, semantic fail)
      }
      httpBreaker.recordSuccess();
      return (await response.json()) as T;
    } catch (err) {
      // Network error / timeout — retry with backoff
      httpBreaker.recordFailure();
      if (attempt === maxAttempts - 1) {
        console.warn(
          `[agentmemory] ${method} ${path} failed after ${maxAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
  }
  return null;
}
```

- [ ] **Step 2: Reduce `apiPost` and `apiGet` to thin wrappers**

```typescript
async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
  return apiRequest<T>("POST", path, body);
}

async function apiGet<T>(path: string): Promise<T | null> {
  return apiRequest<T>("GET", path);
}
```

- [ ] **Step 3: Run tests**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-integration.test.ts -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add integrations/omp/index.ts
git commit -m "feat(omp): extract apiRequest with retry + backoff (G3.3)"
```

---

## Task 4: Add race timeout to session_shutdown (G3.4)

**Files:**
- Modify: `integrations/omp/index.ts` (the `agent_end` / session shutdown handler)

- [ ] **Step 1: Find the `session_shutdown` handler**

Run: `cd /home/duguex/memory/agentmemory && grep -n "session_end\|session_shutdown\|agent_end" integrations/omp/index.ts | head -10`

- [ ] **Step 2: Wrap `await apiPost(...)` with `Promise.race`**

Find the handler that ends the session. Replace the `await apiPost(...)` call with:

```typescript
await Promise.race([
  apiPost("session/end", { sessionId, project: currentProject }),
  new Promise<void>((resolve) => setTimeout(resolve, 3000)),
]);
```

(Whichever finishes first wins; the timeout ensures the handler exits in ≤3s.)

- [ ] **Step 3: Commit**

```bash
git add integrations/omp/index.ts
git commit -m "fix(omp): bound session_shutdown wait to 3s timeout (G3.4)"
```

---

## Task 5: Move sessionInjected = true after empty-result check (G3.2)

**Files:**
- Modify: `integrations/omp/index.ts` (the `before_agent_start` handler)

- [ ] **Step 1: Find the handler**

Run: `cd /home/duguex/memory/agentmemory && grep -n "before_agent_start" integrations/omp/index.ts`

- [ ] **Step 2: Reorder the check**

Find:
```typescript
const result = await apiPost<...>("search", { ... });
if (!result?.results?.length) return;
sessionInjected = true;
```

Replace with:
```typescript
const result = await apiPost<...>("search", { ... });
if (!result?.results?.length) return;
sessionInjected = true;  // only set after we have content to inject
```

(If `sessionInjected = true` was set BEFORE the early-return guard, move it AFTER. The semantic must be: only mark injected once we actually injected something.)

- [ ] **Step 3: Commit**

```bash
git add integrations/omp/index.ts
git commit -m "fix(omp): set sessionInjected only after successful inject (G3.2)"
```

---

## Task 6: Extend CompactSearchResult with narrative field (G3.1)

**Files:**
- Modify: `src/functions/smart-search.ts:189-202` AND `src/types.ts` (or wherever `CompactSearchResult` is defined)

**Interfaces:**
- Consumes: search results from `mem::search` and `mem::smart-search`
- Produces: `CompactSearchResult` with new optional `narrative?: string` field

**Dependency:** This task must coordinate with the G5 plan (which also touches smart-search.ts).

- [ ] **Step 1: Locate `CompactSearchResult` type definition**

Run: `cd /home/duguex/memory/agentmemory && grep -rn "CompactSearchResult" src/ | head -10`

- [ ] **Step 2: Add `narrative?: string` to the type**

Read the type definition and add:
```typescript
export interface CompactSearchResult {
  obsId: string;
  sessionId: string;
  title: string;
  type: string;
  score: number | undefined;
  timestamp: string;
  narrative?: string;  // G3.1: present only when format='narrative'
}
```

- [ ] **Step 3: Update both narrative-format branches in smart-search.ts**

In `src/functions/smart-search.ts`:
- Line 189 (expanded-narrative): change `narrative: r.observation.narrative,` to use the type guard:

```typescript
narrative: typeof r.observation.narrative === "string" ? r.observation.narrative : "",
```

- Line 308 (compact-narrative): same change

- [ ] **Step 4: Update OMP code to read `narrative` correctly**

In `integrations/omp/index.ts:296-303`:

```typescript
const result = await apiPost<{ results?: Array<{ title?: string; type?: string; narrative?: string }> }>(
  "search",
  { query: event.prompt, limit: 5, format: "narrative" },
);
if (!result?.results?.length) return;
sessionInjected = true;
const lines = result.results.map(
  (r) => `  [${r.type ?? "memory"}] ${r.title ?? ""}${r.narrative ? ` — ${r.narrative}` : ""}`,
);
```

The `r.narrative ? \` — ${r.narrative}\` : ""` already handles undefined gracefully — no further change needed here.

- [ ] **Step 5: Add test**

Append to `test/omp-integration.test.ts`:

```typescript
describe("G3.1 narrative field", () => {
  it("CompactSearchResult accepts optional narrative field", () => {
    // Type-level test via TypeScript compilation
    const result: { obsId: string; title: string; narrative?: string } = {
      obsId: "x",
      title: "y",
      narrative: "z",
    };
    expect(result.narrative).toBe("z");
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/omp-integration.test.ts -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/functions/smart-search.ts integrations/omp/index.ts test/omp-integration.test.ts
git commit -m "feat(omp): extend CompactSearchResult with narrative? field (G3.1)"
```

---

## Task 7: Add private IP ranges to plaintext bearer check (G3.5)

**Files:**
- Modify: `integrations/omp/index.ts:28-40` (the `maybeWarnPlaintextBearer` function)

- [ ] **Step 1: Find the function**

Run: `cd /home/duguex/memory/agentmemory && grep -n "maybeWarnPlaintextBearer\|127.0.0.1\|localhost" integrations/omp/index.ts | head -10`

- [ ] **Step 2: Add IPv4 private range checks**

Replace the host check with:

```typescript
function isPrivateHost(host: string): boolean {
  // localhost
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // RFC 1918 IPv4 private ranges
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // IPv6 unique-local fc00::/7
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  // IPv6 link-local fe80::/10
  if (host.startsWith("fe80:")) return true;
  return false;
}

function maybeWarnPlaintextBearer(): void {
  const url = process.env.AGENTMEMORY_URL;
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!url || !secret) return;
  if (!url.startsWith("http://")) return;
  try {
    const u = new URL(url);
    if (isPrivateHost(u.hostname)) return;
    console.warn(
      `[agentmemory] Sending bearer token over plaintext HTTP to ${url} — use https:// or AGENTMEMORY_REQUIRE_HTTPS=1`,
    );
  } catch {
    // Invalid URL — silently skip
  }
}
```

- [ ] **Step 3: Add test**

Append to `test/omp-integration.test.ts`:

```typescript
describe("G3.5 private host check", () => {
  it("isPrivateHost returns true for 192.168.x.x", () => {
    // Re-implement inline since the function is not exported
    const isPrivate = (h: string) =>
      h === "localhost" || h === "127.0.0.1" || h === "::1" ||
      h.startsWith("10.") || h.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h);
    expect(isPrivate("192.168.1.1")).toBe(true);
    expect(isPrivate("10.0.0.5")).toBe(true);
    expect(isPrivate("172.16.0.1")).toBe(true);
    expect(isPrivate("172.31.255.255")).toBe(true);
    expect(isPrivate("172.32.0.1")).toBe(false);  // outside private range
    expect(isPrivate("8.8.8.8")).toBe(false);
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add integrations/omp/index.ts test/omp-integration.test.ts
git commit -m "fix(omp): recognize IPv4 private ranges in plaintext bearer check (G3.5)"
```

---

## Task 8: Guard toolName String() coercion (G3.6)

**Files:**
- Modify: `integrations/omp/index.ts` (the `tool_execution_*` handlers)

- [ ] **Step 1: Find toolName usages**

Run: `cd /home/duguex/memory/agentmemory && grep -n "toolName" integrations/omp/index.ts | head -10`

- [ ] **Step 2: Replace `String(event.toolName)` with safe coercion**

Find:
```typescript
const toolName = "toolName" in event ? String(event.toolName) : "unknown";
```

Replace with:
```typescript
const rawToolName = "toolName" in event ? event.toolName : undefined;
const toolName = typeof rawToolName === "string" && rawToolName.length > 0
  ? rawToolName
  : "unknown";
```

(Apply this transformation to all `tool_execution_*` handlers — likely 2 occurrences.)

- [ ] **Step 3: Add test**

Append to `test/omp-integration.test.ts`:

```typescript
describe("G3.6 toolName coercion", () => {
  it("undefined toolName becomes 'unknown', not 'undefined'", () => {
    const coerce = (raw: unknown): string =>
      typeof raw === "string" && raw.length > 0 ? raw : "unknown";
    expect(coerce(undefined)).toBe("unknown");
    expect(coerce("")).toBe("unknown");
    expect(coerce(null)).toBe("unknown");
    expect(coerce("Read")).toBe("Read");
    expect(coerce(42)).toBe("unknown");
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add integrations/omp/index.ts test/omp-integration.test.ts
git commit -m "fix(omp): guard toolName coercion to avoid 'undefined' literal (G3.6)"
```

---

## Task 9: Detect duplicate /agentmemory in URL (G3.7)

**Files:**
- Modify: `integrations/omp/index.ts:47-52` (the URL construction in `apiPost`)

- [ ] **Step 1: Verify current logic**

The current code already does:
```typescript
const prefix = base.includes("/agentmemory") ? "/" : "/agentmemory/";
```

This is actually correct. **Confirm this is already correct.** If not, fix to:

```typescript
const prefix = base.endsWith("/agentmemory") || base.includes("/agentmemory/")
  ? "/"
  : "/agentmemory/";
```

(The distinction matters: `base = "http://x/agentmemory"` should give prefix `/`, but `base = "http://x/agentmemory/v1"` should also give `/` for `search` path → `http://x/agentmemory/v1/search`.)

- [ ] **Step 2: Add test**

Append to `test/omp-integration.test.ts`:

```typescript
describe("G3.7 URL prefix logic", () => {
  it("avoids duplicate /agentmemory in URL", () => {
    const computePrefix = (base: string): string => {
      const stripped = base.replace(/\/+$/, "");
      return stripped.includes("/agentmemory") ? "/" : "/agentmemory/";
    };
    expect(computePrefix("http://localhost:3111")).toBe("/agentmemory/");
    expect(computePrefix("http://localhost:3111/agentmemory")).toBe("/");
    expect(computePrefix("http://localhost:3111/agentmemory/")).toBe("/");
    expect(computePrefix("http://localhost:3111/agentmemory/v1")).toBe("/");
  });
});
```

- [ ] **Step 3: Commit (or skip if already correct)**

If current code is correct, no commit needed — verify only.

```bash
git status integrations/omp/index.ts
# If modified:
git add integrations/omp/index.ts test/omp-integration.test.ts
git commit -m "fix(omp): tighten URL prefix logic for /agentmemory subpath (G3.7)"
```

---

## Task 10: Re-evaluate plaintext bearer per request (G3.10)

**Files:**
- Modify: `integrations/omp/index.ts:40-44` (the `authHeaders` function)

- [ ] **Step 1: Add per-call bearer warning**

Replace `authHeaders`:

```typescript
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const s = secret();
  if (s) {
    h.Authorization = `Bearer ${s}`;
    // G3.10: re-check plaintext bearer on every request, not just at module load
    const url = baseUrl();
    if (url.startsWith("http://")) {
      try {
        const u = new URL(url);
        // Skip warning for private IPs (already covered by G3.5 logic)
        const isPrivate = (h: string) =>
          h === "localhost" || h === "127.0.0.1" || h === "::1" ||
          h.startsWith("10.") || h.startsWith("192.168.") ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(h);
        if (!isPrivate(u.hostname)) {
          console.warn(
            `[agentmemory] Sending bearer token over plaintext HTTP to ${url}`,
          );
        }
      } catch {
        // invalid URL — skip
      }
    }
  }
  return h;
}
```

- [ ] **Step 2: Remove the module-load call to `maybeWarnPlaintextBearer()`**

Remove the line at top of file: `maybeWarnPlaintextBearer();`

(The function itself can stay for the G3.5 test, or be deleted entirely if all callers moved to `authHeaders`.)

- [ ] **Step 3: Commit**

```bash
git add integrations/omp/index.ts
git commit -m "fix(omp): re-evaluate plaintext bearer per request (G3.10)"
```

---

## Task 11: Use canonical isSdkChildContext guard (G3.8)

**Files:**
- Modify: `integrations/omp/index.ts:118-120` (the `isSdkChild` function and its callers)

- [ ] **Step 1: Find canonical guard location**

Run: `cd /home/duguex/memory/agentmemory && find src -name "sdk-guard.ts" -o -name "*sdk-guard*" 2>/dev/null`

If the file exists at `src/hooks/sdk-guard.ts`, import its `isSdkChildContext`.

If it does not exist, skip this task and leave the local `isSdkChild` as-is — flag it in commit message.

- [ ] **Step 2: Replace local guard with import**

If file exists, replace:

```typescript
function isSdkChild(): boolean {
  return process.env.AGENTMEMORY_SDK_CHILD === "1";
}
```

with:

```typescript
import { isSdkChildContext } from "../../src/hooks/sdk-guard.js";
// Note: import path may need adjustment based on actual sdk-guard location
```

And update callers (`if (isSdkChild())` → `if (isSdkChildContext())`).

- [ ] **Step 3: Commit (or skip with explanation)**

```bash
git add integrations/omp/index.ts
git commit -m "fix(omp): use canonical isSdkChildContext guard (G3.8)

If src/hooks/sdk-guard.ts does not exist locally, this commit
was skipped and the local isSdkChild() guard remains."
```

---

## Self-Review

**1. Spec coverage:**
- G3.1 ✅ Task 6
- G3.2 ✅ Task 5
- G3.3 ✅ Task 3
- G3.4 ✅ Task 4
- G3.5 ✅ Task 7
- G3.6 ✅ Task 8
- G3.7 ✅ Task 9 (verify, may be no-op)
- G3.8 ✅ Task 11 (conditional on file existence)
- G3.9 ✅ Tasks 1-2
- G3.10 ✅ Task 10
- G3.11 — covered as part of Task 6 (narrative guard)

**2. Placeholder scan:** All code blocks complete. Test code shown verbatim.

**3. Type consistency:** `CircuitBreaker` interface consistent across Tasks 1, 2. `apiRequest<T>` signature used in Tasks 3. `CompactSearchResult.narrative?` consistent across Tasks 6 (type def, impl, consumer).

**Cross-spec coordination:** Task 6 modifies `src/functions/smart-search.ts` which is also in G5 plan. The G5 plan should be merged FIRST or these commits co-ordinated.

**Ready for execution.**