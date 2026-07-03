# src/index.ts + src/config.ts Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 defects in `src/index.ts` and `src/config.ts` covering timer leaks, registration gates, default values, and shutdown cleanup.

**Architecture:** Surgical changes to existing functions. No new modules. Add a `_cleanupTimers` array that captures all setInterval returns; gate registrations behind config flags; restore 1h default for auto-forget; add double-gate for graph extraction. Existing test patterns (`vi.mock("iii-sdk")`) apply.

**Tech Stack:** TypeScript 5, vitest, iii-sdk.

## Global Constraints

- ESM only, TypeScript strict
- All `setInterval` MUST call `.unref()` and be added to `_cleanupTimers`
- All `registerXFunction` calls MUST honor the corresponding `isXEnabled()` gate (or self-gate)
- Spec reference: `docs/superpowers/specs/2026-07-03-omp-adaptation-fixes-design.md` §G4
- Cross-spec dependency: G4.3 (claude-bridge/graph endpoints) decision affects G5.2 (REST format whitelist)

---

## File Structure

| File | Role |
|---|---|
| `src/config.ts` | MODIFY — restore 1h default in `getAutoForgetIntervalMs()` |
| `src/index.ts` | MODIFY — restore `.unref()`, add gates, fix `_cleanupTimers` |
| `src/functions/graph.ts` | MODIFY — add self-gate in `mem::graph-extract` |
| `test/index-config.test.ts` | CREATE — vitest tests |

No new files in `src/`. Only 1 test file.

---

## Task 1: Restore 1h default for auto-forget (G4.6)

**Files:**
- Modify: `src/config.ts:156-164` (the `getAutoForgetIntervalMs` function)

- [ ] **Step 1: Write failing test**

Create `test/index-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAutoForgetIntervalMs } from "../src/config.js";

describe("getAutoForgetIntervalMs (G4.6)", () => {
  let origAutoForget: string | undefined;
  let origLegacy: string | undefined;

  beforeEach(() => {
    origAutoForget = process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    origLegacy = process.env.AUTO_FORGET_INTERVAL_MS;
    delete process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    delete process.env.AUTO_FORGET_INTERVAL_MS;
  });

  afterEach(() => {
    if (origAutoForget !== undefined) process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = origAutoForget;
    else delete process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL;
    if (origLegacy !== undefined) process.env.AUTO_FORGET_INTERVAL_MS = origLegacy;
    else delete process.env.AUTO_FORGET_INTERVAL_MS;
  });

  it("returns 1h default when no env var is set", () => {
    expect(getAutoForgetIntervalMs()).toBe(3_600_000);
  });

  it("respects AGENTMEMORY_AUTO_FORGET_INTERVAL override", () => {
    process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = "1800000";
    expect(getAutoForgetIntervalMs()).toBe(1_800_000);
  });

  it("falls back to legacy AUTO_FORGET_INTERVAL_MS", () => {
    process.env.AUTO_FORGET_INTERVAL_MS = "600000";
    expect(getAutoForgetIntervalMs()).toBe(600_000);
  });

  it("prefers AGENTMEMORY_AUTO_FORGET_INTERVAL over legacy", () => {
    process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL = "1000";
    process.env.AUTO_FORGET_INTERVAL_MS = "9999";
    expect(getAutoForgetIntervalMs()).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/index-config.test.ts -v`
Expected: FAIL — first test expects `3_600_000`, current code returns `0`

- [ ] **Step 3: Fix `getAutoForgetIntervalMs()`**

In `src/config.ts:156-164`, replace:

```typescript
export function getAutoForgetIntervalMs(): number {
  // Prefer new env var; fall back to legacy AUTO_FORGET_INTERVAL_MS for backward compat.
  const val =
    getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL") ||
    process.env.AUTO_FORGET_INTERVAL_MS ||
    "";
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
```

with:

```typescript
export function getAutoForgetIntervalMs(): number {
  // G4.6: restore 1h default (was 0 → silent regression for existing deployments)
  const DEFAULT_MS = 3_600_000;
  const val =
    getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL") ||
    process.env.AUTO_FORGET_INTERVAL_MS ||
    String(DEFAULT_MS);
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/index-config.test.ts -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/index-config.test.ts
git commit -m "fix(config): restore 1h default for auto-forget interval (G4.6)"
```

---

## Task 2: Add .unref() to cleanup timers (G4.1)

**Files:**
- Modify: `src/index.ts:264-278` (the auto-forget and eviction timer blocks)

- [ ] **Step 1: Locate the blocks**

Run: `cd /home/duguex/memory/agentmemory && grep -n "setInterval.*auto-forget\|setInterval.*evict" src/index.ts`

- [ ] **Step 2: Add `.unref()` to both timers**

Find each `setInterval(...)` in the cleanup section. Replace:
```typescript
_cleanupTimers.push(setInterval(() => {
  sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: TriggerAction.Void() }).catch(() => {});
}, autoForgetMs));
```

with:
```typescript
_cleanupTimers.push(setInterval(() => {
  sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: TriggerAction.Void() }).catch(() => {});
}, autoForgetMs).unref());
```

Apply the same `.unref()` to the eviction timer.

- [ ] **Step 3: Verify with grep**

Run: `cd /home/duguex/memory/agentmemory && grep -A1 "setInterval.*auto-forget" src/index.ts | head -5`
Expected: Line ends with `.unref());`

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "fix(index): add .unref() to cleanup timers (G4.1)"
```

---

## Task 3: Disable legacy auto-forget when new timer is active (G4.2)

**Files:**
- Modify: `src/index.ts` (where `autoForgetMs > 0` is checked + the legacy auto-forget block at line ~553)

- [ ] **Step 1: Find legacy auto-forget block**

Run: `cd /home/duguex/memory/agentmemory && grep -n "AUTO_FORGET_INTERVAL_MS\|AUTO_FORGET_ENABLED" src/index.ts`

- [ ] **Step 2: Set AUTO_FORGET_ENABLED=false before legacy check**

Just before the `if (process.env.AUTO_FORGET_ENABLED !== "false")` block, add:

```typescript
// G4.2: when new auto-forget timer is scheduled, suppress legacy timer
if (autoForgetMs > 0) {
  process.env.AUTO_FORGET_ENABLED = "false";
}
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix(index): disable legacy auto-forget when new timer active (G4.2)"
```

---

## Task 4: Restore registration gates for graph + claude-bridge (G4.3, G4.7, G4.8)

**Files:**
- Modify: `src/index.ts:283-290` (the `registerGraphFunction` and `registerClaudeBridgeFunction` calls)

- [ ] **Step 1: Find the calls**

Run: `cd /home/duguex/memory/agentmemory && grep -n "registerGraphFunction\|registerClaudeBridgeFunction" src/index.ts`

- [ ] **Step 2: Wrap both in config gates**

Replace:
```typescript
registerClaudeBridgeFunction(sdk, kv, loadClaudeBridgeConfig());
registerGraphFunction(sdk, kv, provider);
```

with:

```typescript
// G4.8: restore claude-bridge registration gate
const claudeBridgeConfig = loadClaudeBridgeConfig();
if (claudeBridgeConfig.enabled) {
  registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
  bootLog(`Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`);
}

// G4.7: restore graph registration gate (defense in depth — also gated in function body)
if (isGraphExtractionEnabled()) {
  registerGraphFunction(sdk, kv, provider);
  bootLog(`Knowledge graph: extraction enabled`);
}
```

Note: This means the G5.2 (REST format whitelist) plan should reference these gates.

- [ ] **Step 3: Add function-body guard for graph (G4.7 second gate)**

In `src/functions/graph.ts`, find the `mem::graph-extract` function (search for `registerFunction("mem::graph-extract"`). Add at the very start of the handler:

```typescript
if (!isGraphExtractionEnabled()) {
  return {
    success: false,
    error: "graph extraction disabled",
    code: "GRAPH_DISABLED",
  };
}
```

(You may need to import `isGraphExtractionEnabled` from `../config.js` if not already imported.)

- [ ] **Step 4: Write test for the dual gate**

Append to `test/index-config.test.ts`:

```typescript
import { isGraphExtractionEnabled } from "../src/config.js";

describe("graph extraction gates (G4.7)", () => {
  let origGraph: string | undefined;

  beforeEach(() => {
    origGraph = process.env.GRAPH_EXTRACTION_ENABLED;
  });

  afterEach(() => {
    if (origGraph !== undefined) process.env.GRAPH_EXTRACTION_ENABLED = origGraph;
    else delete process.env.GRAPH_EXTRACTION_ENABLED;
  });

  it("isGraphExtractionEnabled returns false by default", () => {
    delete process.env.GRAPH_EXTRACTION_ENABLED;
    expect(isGraphExtractionEnabled()).toBe(false);
  });

  it("isGraphExtractionEnabled returns true when env=true", () => {
    process.env.GRAPH_EXTRACTION_ENABLED = "true";
    expect(isGraphExtractionEnabled()).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/index-config.test.ts -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/functions/graph.ts test/index-config.test.ts
git commit -m "fix(index): restore registration gates for graph + claude-bridge (G4.3/4.7/4.8)"
```

---

## Task 5: Gate consolidation pipeline registration (G4.4)

**Files:**
- Modify: `src/index.ts:281-286` (the `registerConsolidationPipelineFunction` call)

- [ ] **Step 1: Find the call**

Run: `cd /home/duguex/memory/agentmemory && grep -n "registerConsolidationPipelineFunction" src/index.ts`

- [ ] **Step 2: Wrap in `isConsolidationEnabled()` gate**

Find:
```typescript
registerConsolidationPipelineFunction(sdk, kv, provider);
bootLog(`Consolidation pipeline: registered (CONSOLIDATION_ENABLED=${isConsolidationEnabled() ? "true" : "false"})`);
```

Replace with:
```typescript
// G4.4: gate consolidation pipeline registration
if (isConsolidationEnabled()) {
  registerConsolidationPipelineFunction(sdk, kv, provider);
  bootLog(`Consolidation pipeline: registered`);
} else {
  bootLog(`Consolidation pipeline: disabled (CONSOLIDATION_ENABLED=false)`);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix(index): gate consolidation pipeline by isConsolidationEnabled (G4.4)"
```

---

## Task 6: Track legacy timers in _cleanupTimers (G4.5)

**Files:**
- Modify: `src/index.ts` (5 legacy setInterval blocks at ~lines 553-595)

- [ ] **Step 1: Find all setInterval calls**

Run: `cd /home/duguex/memory/agentmemory && grep -n "setInterval" src/index.ts`

- [ ] **Step 2: Identify legacy (non-_cleanupTimers) timers**

There should be 5 legacy timers (lessonDecay, insightDecay, recentSearchesSweep, consolidation, and possibly one more) that are NOT in the _cleanupTimers array. List them.

- [ ] **Step 3: Add each legacy timer to _cleanupTimers**

For each legacy timer like:
```typescript
const lessonDecayTimer = setInterval(async () => { ... }, LESSON_DECAY_INTERVAL_MS);
lessonDecayTimer.unref();
```

Ensure:
1. `.unref()` is called on the returned timer
2. The timer is pushed into `_cleanupTimers`:

```typescript
_cleanupTimers.push(lessonDecayTimer);
```

- [ ] **Step 4: Verify shutdown cleanup covers all timers**

Read the shutdown handler (search for `clearInterval` in `src/index.ts`). Confirm it iterates ALL of `_cleanupTimers` (not just a subset).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "fix(index): track all 5 legacy timers in _cleanupTimers (G4.5)"
```

---

## Self-Review

**1. Spec coverage:**
- G4.1 ✅ Task 2 (.unref on cleanup timers)
- G4.2 ✅ Task 3 (disable legacy when new active)
- G4.3 + G4.7 + G4.8 ✅ Task 4 (registration gates)
- G4.4 ✅ Task 5 (consolidation gate)
- G4.5 ✅ Task 6 (legacy timer tracking)
- G4.6 ✅ Task 1 (1h default)

**2. Placeholder scan:** No TBDs. Code complete. Test code shown verbatim.

**3. Type consistency:** `getAutoForgetIntervalMs(): number` consistent in tests and impl. `isGraphExtractionEnabled(): boolean` consistent.

**Cross-spec:** Task 4 changes affect G5.2 — REST endpoints for graph may need to align. Document in commit message.

**Ready for execution.**