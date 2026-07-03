# smart-search + MCP + REST Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 defects across 3 files for end-to-end narrative-format consistency: MCP wrapper unwrap, REST format whitelist, score consistency, truncated field consistency.

**Architecture:** Pure coordination fix. Each task touches exactly one location, no new modules. The wrapper/MCP changes are the smallest possible (drop one condition). The REST change adds one field to a whitelist. The smart-search changes affect 2 lines (score) and 1 field addition (truncated).

**Tech Stack:** TypeScript 5, vitest, iii-sdk.

## Global Constraints

- ESM only, TypeScript strict
- Spec reference: `docs/superpowers/specs/2026-07-03-omp-adaptation-fixes-design.md` §G5
- Cross-spec dependency: G5.3 depends on G3.6 (CompactSearchResult.narrative? field) being merged first
- Backward compat: existing MCP/REST clients continue to work; new fields are additive

---

## File Structure

| File | Role |
|---|---|
| `src/functions/smart-search.ts` | MODIFY — score consistency (G5.3) + truncated field (G5.4) |
| `src/mcp/server.ts` | MODIFY — wrapper unwrap for compact-mode narrative (G5.1) |
| `src/triggers/api.ts` | MODIFY — REST format whitelist (G5.2) |
| `test/smart-search-mcp-rest.test.ts` | CREATE — vitest tests |

No new modules.

---

## Task 1: Add failing test for score consistency in expanded branches (G5.3)

**Files:**
- Create: `test/smart-search-mcp-rest.test.ts`

- [ ] **Step 1: Create test file with score consistency test**

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock iii-sdk BEFORE importing the function under test
vi.mock("iii-sdk", () => ({
  registerWorker: vi.fn(() => ({
    registerFunction: vi.fn(),
    registerTrigger: vi.fn(),
    trigger: vi.fn(),
  })),
  TriggerAction: { Void: () => ({ type: "void" }) },
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";

describe("smart-search score consistency (G5.3)", () => {
  it("expanded-narrative returns score from underlying result, not undefined", async () => {
    const sdk = {
      registerFunction: vi.fn(),
      trigger: vi.fn().mockResolvedValue({
        // Mock search result with combinedScore
        results: [
          { observation: { id: "o1", sessionId: "s1", title: "t1", type: "fact", narrative: "n1", timestamp: "2026-07-01" }, combinedScore: 0.85 },
        ],
        truncated: false,
      }),
    };
    const kv = { get: vi.fn(), set: vi.fn(), list: vi.fn() };

    registerSmartSearchFunction(sdk as any, kv as any);

    // Find the registered handler
    const handlerCall = (sdk.registerFunction as any).mock.calls.find(
      (c: any[]) => c[0] === "mem::smart-search",
    );
    expect(handlerCall).toBeDefined();
    const handler = handlerCall[1];

    // Call with expandIds + format=narrative
    const result = await handler({
      expandIds: [{ obsId: "o1", sessionId: "s1" }],
      format: "narrative",
    });

    expect(result.mode).toBe("expanded");
    expect(result.format).toBe("narrative");
    expect(result.results[0].score).toBe(0.85);  // NOT undefined
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: FAIL — `result.results[0].score` is `undefined`, expected `0.85`

- [ ] **Step 3: Commit failing test**

```bash
git add test/smart-search-mcp-rest.test.ts
git commit -m "test(smart-search): add failing test for score consistency (G5.3)"
```

---

## Task 2: Fix score consistency in expanded branches (G5.3)

**Files:**
- Modify: `src/functions/smart-search.ts:184, 195`

- [ ] **Step 1: Locate both score: undefined lines**

Run: `cd /home/duguex/memory/agentmemory && grep -n "score: undefined" src/functions/smart-search.ts`

- [ ] **Step 2: Replace with r.combinedScore**

Find the expanded-compact branch (around line 184):
```typescript
const compactResults = scoped.map((r) => ({
  ...
  score: undefined,
  ...
}));
```

Replace `score: undefined` with `score: r.combinedScore`.

Note: `scoped` items come from `expanded` filter, which is built from the searcher. Check that the items have `combinedScore`. If not, use `r.observation.score` (older fallback) — verify in:

Run: `cd /home/duguex/memory/agentmemory && grep -B2 -A5 "expanded.filter" src/functions/smart-search.ts | head -30`

If the expanded items do NOT have `combinedScore`, set:
```typescript
score: (r as any).combinedScore ?? r.observation.importance,
```

Where `importance` is a 0-10 number (which is the field in CompressedObservation).

- [ ] **Step 3: Apply the same fix to expanded-narrative branch (line 195)**

Same replacement.

- [ ] **Step 4: Run test**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite to check no regressions**

Run: `cd /home/duguex/memory/agentmemory && npm test 2>&1 | tail -30`
Expected: All previously-passing tests still pass; only the new tests should change behavior

- [ ] **Step 6: Commit**

```bash
git add src/functions/smart-search.ts
git commit -m "fix(smart-search): use r.combinedScore instead of undefined in expanded branches (G5.3)"
```

---

## Task 3: Add truncated field to compact-narrative response (G5.4)

**Files:**
- Modify: `src/functions/smart-search.ts:333-340`

- [ ] **Step 1: Write failing test**

Append to `test/smart-search-mcp-rest.test.ts`:

```typescript
describe("smart-search compact-narrative truncated field (G5.4)", () => {
  it("compact-narrative response includes truncated field", async () => {
    const sdk = {
      registerFunction: vi.fn(),
      trigger: vi.fn().mockResolvedValue({
        results: [
          { observation: { id: "o1", title: "t1", type: "fact", narrative: "n1", timestamp: "2026-07-01" }, combinedScore: 0.5 },
        ],
        truncated: true,
      }),
    };
    const kv = { get: vi.fn(), set: vi.fn(), list: vi.fn() };

    registerSmartSearchFunction(sdk as any, kv as any);
    const handlerCall = (sdk.registerFunction as any).mock.calls.find(
      (c: any[]) => c[0] === "mem::smart-search",
    );
    const handler = handlerCall[1];

    const result = await handler({
      query: "test",
      format: "narrative",
      includeLessons: false,
    });

    expect(result.mode).toBe("compact");
    expect(result.format).toBe("narrative");
    expect(result.truncated).toBeDefined();  // was undefined pre-fix
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: FAIL — `truncated` is undefined

- [ ] **Step 3: Add truncated field to narrativeResponse**

In `src/functions/smart-search.ts:333-340`, replace:
```typescript
const narrativeResponse: { ... } = {
  mode: "compact",
  format: "narrative",
  results: narrativeResults,
  text,
};
```

with:
```typescript
const narrativeResponse: { ... } = {
  mode: "compact",
  format: "narrative",
  results: narrativeResults,
  text,
  truncated: filteredHybrid.length > narrativeResults.length,  // G5.4
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/functions/smart-search.ts test/smart-search-mcp-rest.test.ts
git commit -m "fix(smart-search): add truncated field to compact-narrative response (G5.4)"
```

---

## Task 4: Fix MCP wrapper to unwrap compact-narrative text (G5.1)

**Files:**
- Modify: `src/mcp/server.ts:286`

- [ ] **Step 1: Write failing test**

Append to `test/smart-search-mcp-rest.test.ts`:

```typescript
import { handleMcpToolCall } from "../src/mcp/server.js";

describe("MCP memory_smart_search narrative unwrap (G5.1)", () => {
  it("unwraps .text for compact-mode narrative response", async () => {
    const sdk = {
      trigger: vi.fn().mockResolvedValue({
        mode: "compact",        // NOT expanded
        format: "narrative",
        text: "1. Some Title\nThe narrative content",
        results: [{ obsId: "o1", title: "Some Title", narrative: "The narrative content" }],
        truncated: false,
      }),
    };

    const result = await handleMcpToolCall(sdk as any, "memory_smart_search", {
      query: "test",
      format: "narrative",
    });

    // Expect .text content, not JSON
    expect(result.status_code).toBe(200);
    expect(result.body.content[0].text).toBe("1. Some Title\nThe narrative content");
    expect(result.body.content[0].text).not.toContain('"mode"');  // not JSON-stringified
  });

  it("still unwraps .text for expanded-mode narrative (regression check)", async () => {
    const sdk = {
      trigger: vi.fn().mockResolvedValue({
        mode: "expanded",
        format: "narrative",
        text: "1. Expanded Title\nExpanded narrative",
        results: [{ obsId: "o2", title: "Expanded Title" }],
        truncated: false,
      }),
    };

    const result = await handleMcpToolCall(sdk as any, "memory_smart_search", {
      query: "test",
      format: "narrative",
      expandIds: ["o2"],
    });

    expect(result.body.content[0].text).toBe("1. Expanded Title\nExpanded narrative");
  });
});
```

Note: This requires `handleMcpToolCall` to be exported from `src/mcp/server.ts`. If it's not currently exported, the test setup needs to use a different entrypoint. Adjust as needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: FAIL — first test (compact-mode) returns JSON, not text

- [ ] **Step 3: Fix the gate in src/mcp/server.ts**

Find line 286:
```typescript
if (result && typeof result === "object" && result.mode === "expanded" && result.format === "narrative" && typeof result.text === "string") {
```

Replace with:
```typescript
if (result && typeof result === "object" && result.format === "narrative" && typeof result.text === "string") {
```

(Drop `result.mode === "expanded"` so the gate accepts both expanded and compact narrative responses.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/smart-search-mcp-rest.test.ts
git commit -m "fix(mcp): unwrap .text for compact-mode narrative (G5.1)"
```

---

## Task 5: Add format to REST /agentmemory/smart-search whitelist (G5.2)

**Files:**
- Modify: `src/triggers/api.ts:1157-1166`

- [ ] **Step 1: Write failing test**

Append to `test/smart-search-mcp-rest.test.ts`:

```typescript
describe("REST /agentmemory/smart-search format whitelist (G5.2)", () => {
  it("passes format field through to mem::smart-search", async () => {
    const sdk = {
      registerFunction: vi.fn(),
      registerTrigger: vi.fn(),
      trigger: vi.fn().mockResolvedValue({ mode: "compact", format: "narrative", text: "narrative text" }),
    };
    // Import the registration logic
    const { registerApiSmartSearch } = await import("../src/triggers/api.js");
    registerApiSmartSearch(sdk as any, "secret");

    const handlerCall = (sdk.registerFunction as any).mock.calls.find(
      (c: any[]) => c[0] === "api::smart-search",
    );
    expect(handlerCall).toBeDefined();
    const handler = handlerCall[1];

    // Simulate REST call with format field
    const result = await handler({
      body: { query: "test", format: "narrative" },
      headers: {},
    });

    expect(result.status_code).toBe(200);
    // Verify sdk.trigger was called with format in payload
    const triggerCall = (sdk.trigger as any).mock.calls[0];
    expect(triggerCall[0].payload.format).toBe("narrative");
  });
});
```

Note: This requires `registerApiSmartSearch` (or equivalent function) to be exported from `src/triggers/api.ts`. If the registration is inline in another file (e.g., `src/index.ts`), this test needs adjustment.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: FAIL — `format` is stripped from payload

- [ ] **Step 3: Add format to whitelist**

In `src/triggers/api.ts:1157-1166`, find:
```typescript
const payload = {
  query: req.body?.query,
  expandIds: req.body?.expandIds,
  limit: req.body?.limit,
  project: req.body?.project,
  includeLessons: req.body?.includeLessons,
  agentId: req.body?.agentId,
  sessionId: req.body?.sessionId,
  source: req.body?.source ?? sourceFromHeader,
};
```

Replace with:
```typescript
const payload = {
  query: req.body?.query,
  expandIds: req.body?.expandIds,
  limit: req.body?.limit,
  project: req.body?.project,
  includeLessons: req.body?.includeLessons,
  agentId: req.body?.agentId,
  sessionId: req.body?.sessionId,
  source: req.body?.source ?? sourceFromHeader,
  format: req.body?.format,  // G5.2
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/duguex/memory/agentmemory && npx vitest run test/smart-search-mcp-rest.test.ts -v`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /home/duguex/memory/agentmemory && npm test 2>&1 | tail -30`
Expected: All tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/triggers/api.ts test/smart-search-mcp-rest.test.ts
git commit -m "fix(api): add format to /agentmemory/smart-search whitelist (G5.2)"
```

---

## Self-Review

**1. Spec coverage:**
- G5.1 ✅ Task 4 (MCP wrapper unwrap)
- G5.2 ✅ Task 5 (REST format whitelist)
- G5.3 ✅ Tasks 1-2 (score consistency)
- G5.4 ✅ Task 3 (truncated field)

**2. Placeholder scan:** No TBDs. Code complete.

**3. Type consistency:** `result.format === "narrative" && typeof result.text === "string"` consistent in MCP test and impl. `narrativeResponse.truncated` field consistent.

**Cross-spec coordination:**
- G5.3 (score) depends on G3.6 (CompactSearchResult.narrative?) — if G5.3 is merged before G3.6, the type definition needs to be updated first or in the same commit
- G5.2 (REST format) depends on G4.3 (graph/claude-bridge gates) — graph-related REST endpoints may need alignment with the new registration gates

**Backward compat:** All changes are additive (new fields, wider gates, added whitelist). Existing clients unaffected.

**Ready for execution.**