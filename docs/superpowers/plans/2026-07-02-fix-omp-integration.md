# OMP Integration Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 8 issues in `integrations/omp/index.ts`: narrative field, sessionInjected order, AbortSignal timeout, session_shutdown timeout, private IP detection, String(undefined), URL path, SDK child guard

**Architecture:** Single TypeScript file. All fixes are local to the OMP extension. No new files.

**Tech Stack:** TypeScript, Node.js fetch API

## Global Constraints

- All changes in `integrations/omp/index.ts`
- No new npm dependencies
- Must compile with `npm run build`

---

### Task 1: Fix r.narrative — call search endpoint with format=narrative

**Files:**
- Modify: `integrations/omp/index.ts:274-285`

**Interfaces:**
- Consumes: AgentMemory `/search?format=narrative` endpoint (returns `narrative` field)
- Produces: Recall block with narrative descriptions

- [ ] **Step 1: Read current before_agent_start handler**

```bash
grep -n -A20 "before_agent_start" ~/memory/agentmemory/integrations/omp/index.ts | head -25
```

- [ ] **Step 2: Replace smart-search call with search endpoint call**

Current code uses `smart-search` which returns `CompactSearchResult` (no narrative). Replace with `/search` endpoint that supports `format: "narrative"`:

```typescript
const result = await apiPost<{ results?: Array<{ title?: string; type?: string; narrative?: string }> }>(
    "search",
    { query: event.prompt, limit: 5, format: "narrative" },
);
```

- [ ] **Step 3: Build to verify compilation**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
cd ~/memory/agentmemory && git add integrations/omp/index.ts && git commit -m "fix: use /search?format=narrative endpoint to get narrative in recall block"
```

---

### Task 2: Move sessionInjected after result check

**Files:**
- Modify: `integrations/omp/index.ts:279-280`

- [ ] **Step 1: Move flag assignment**

Current:
```typescript
sessionInjected = true;
if (!result?.results?.length) return;
```

Change to:
```typescript
if (!result?.results?.length) return;
sessionInjected = true;
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: move sessionInjected=true after empty results check"
```

---

### Task 3: Add AbortSignal.timeout to fetch calls

**Files:**
- Modify: `integrations/omp/index.ts:60-72`

- [ ] **Step 1: Add timeout to apiPost/apiGet**

```typescript
async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

async function apiGet<T = unknown>(path: string): Promise<T | null> {
    const url = `${baseUrl().replace(/\/+$/, "")}/agentmemory/${path}`;
    try {
        const res = await fetch(url, {
            headers: authHeaders(),
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: add AbortSignal.timeout(3000) to fetch calls"
```

---

### Task 4: session_shutdown await with timeout

**Files:**
- Modify: `integrations/omp/index.ts:232`

- [ ] **Step 1: Replace await with race**

```typescript
pi.on("session_shutdown", async () => {
    await Promise.race([
        apiPost("session/end", { sessionId, reason: "shutdown" }),
        new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
});
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: session_shutdown await with 3s timeout, fallback to fire-and-forget"
```

---

### Task 5: Plaintext bearer — detect private IPs

**Files:**
- Modify: `integrations/omp/index.ts:28-34`

- [ ] **Step 1: Expand the allowlist**

```typescript
function maybeWarnPlaintextBearer(): void {
    const url = process.env.AGENTMEMORY_URL ?? "";
    if (!url.startsWith("http://")) return;
    if (!process.env.AGENTMEMORY_SECRET) return;
    // Allow loopback addresses
    if (url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1")) return;
    // Also allow private network IPs over plaintext (same security boundary)
    if (url.match(/https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/)) return;
    console.warn("[agentmemory] Sending bearer token over plaintext HTTP to " + url + ". Use https:// in production.");
}
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: allow private-network IPs (192.168., 10., 172.16-31.) in plaintext bearer warning"
```

---

### Task 6: String(undefined) tool name guard

**Files:**
- Modify: `integrations/omp/index.ts:239-240`

- [ ] **Step 1: Fix tool name extraction**

```typescript
const rawName = "toolName" in event ? event.toolName : undefined;
const toolName = (typeof rawName === "string" && rawName.length > 0) ? rawName : "unknown";
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: guard against String(undefined) as tool name"
```

---

### Task 7: URL mount path — avoid double /agentmemory/

**Files:**
- Modify: `integrations/omp/index.ts:62`

- [ ] **Step 1: Fix URL construction**

```typescript
function baseUrl(): string {
    return (process.env.AGENTMEMORY_URL ?? "http://localhost:3111").replace(/\/+$/, "");
}

async function apiPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const base = baseUrl();
    // Avoid double /agentmemory/ prefix when AGENTMEMORY_URL already has it
    const prefix = base.includes("/agentmemory") ? "" : "/agentmemory/";
    const url = `${base}${prefix}${path}`;
    // ... rest of function
}
```

Similarly for `apiGet`.

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: detect AGENTMEMORY_URL mount path to avoid double /agentmemory/ prefix"
```

---

### Task 8: SDK child guard — import isSdkChildContext

**Files:**
- Modify: `integrations/omp/index.ts:110`

- [ ] **Step 1: Check if sdk-guard.ts exists and is importable**

```bash
grep -r "isSdkChildContext" ~/memory/agentmemory/src/ --include="*.ts" | head -5
```

If `isSdkChildContext` exists in a shared location, replace the env var check:

```typescript
import { isSdkChildContext } from "../../src/hooks/sdk-guard.js";

// In factory:
if (isSdkChildContext()) return;
```

If the function doesn't exist or isn't importable (e.g., runtime dependency), re-export or inline the canonical check:

```typescript
function isSdkChild(): boolean {
    return process.env.AGENTMEMORY_SDK_CHILD === "1"
        || (typeof process !== "undefined" && (process as any).argv?.some?.((a: string) => a.includes("sdk-ts")));
}
```

- [ ] **Step 2: Build + Commit**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
git commit -m "fix: align SDK child guard with canonical isSdkChildContext implementation"
```
