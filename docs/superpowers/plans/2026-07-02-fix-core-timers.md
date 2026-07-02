# Core Timer Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 issues in `src/index.ts` and `src/triggers/api.ts`: missing .unref(), duplicate auto-forget, dead API endpoints, unconditional consolidation, legacy timers not cleared on shutdown

**Architecture:** Core runtime file + HTTP trigger registration. Requires build after changes.

**Tech Stack:** TypeScript, iii-sdk

## Global Constraints

- Changes in `src/index.ts` and possibly `src/triggers/api.ts`
- Must compile with `npm run build`
- After build, deploy to global dist: `cp dist/index.mjs $(npm root -g)/@agentmemory/agentmemory/dist/index.mjs`

---

### Task 1: Add .unref() to new cleanup timers

**Files:**
- Modify: `src/index.ts:264-274`

- [ ] **Step 1: Read current timer code**

```bash
grep -n -B1 -A4 "_cleanupTimers.push\|setInterval" ~/memory/agentmemory/src/index.ts | head -30
```

- [ ] **Step 2: Add .unref() to both new timers**

```typescript
// auto-forget (line 264-266)
_cleanupTimers.push(setInterval(() => {
    sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: TriggerAction.Void() }).catch(() => {});
}, autoForgetMs).unref());
// ^^ .unref() added

// evict (line 272-274)
_cleanupTimers.push(setInterval(() => {
    sdk.trigger({ function_id: "mem::evict", payload: {}, action: TriggerAction.Void() }).catch(() => {});
}, evictMs).unref());
// ^^ .unref() added
```

- [ ] **Step 3: Build + verify**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Deploy + commit**

```bash
cp dist/index.mjs $(npm root -g)/@agentmemory/agentmemory/dist/index.mjs
git add src/index.ts && git commit -m "fix: add .unref() to new _cleanupTimers setInterval timers"
```

---

### Task 2: Fix duplicate auto-forget — new env var overrides legacy

**Files:**
- Modify: `src/index.ts:261-267` and `src/index.ts:543-544`

- [ ] **Step 1: Add override logic near the legacy timer gate**

When the new env var `AGENTMEMORY_AUTO_FORGET_INTERVAL` is set (> 0), force-disable the legacy timer:

```typescript
// Line 543 — before the legacy timer
if (getAutoForgetIntervalMs() > 0) {
    // New timer is active — disable legacy to prevent duplicate schedule
    process.env.AUTO_FORGET_ENABLED = "false";
}
```

This goes right before `if (process.env.AUTO_FORGET_ENABLED !== "false") {`.

- [ ] **Step 2: Build + verify**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 3: Deploy + commit**

```bash
cp dist/index.mjs $(npm root -g)/@agentmemory/agentmemory/dist/index.mjs
git add src/index.ts && git commit -m "fix: new AGENTMEMORY_AUTO_FORGET_INTERVAL overrides legacy AUTO_FORGET_INTERVAL_MS to prevent duplicate schedule"
```

---

### Task 3: Handle claude-bridge/graph dead endpoints

**Files:**
- Modify: `src/triggers/api.ts`

- [ ] **Step 1: Read current API endpoint registrations**

```bash
grep -n "claude-bridge\|graph-query\|graph-extract\|graph-build\|graph-stats\|snapshot-rebuild\|graph-reset" ~/memory/agentmemory/src/triggers/api.ts | head -15
```

- [ ] **Step 2: Remove the 8 dead endpoints**

Each endpoint references a function_id that no longer has a registered handler. Remove them:

- `mem::claude-bridge-read`
- `mem::claude-bridge-sync`
- `mem::graph-query`
- `mem::graph-extract`
- `mem::graph-build`
- `mem::graph-stats`
- `mem::snapshot-rebuild`
- `mem::graph-reset`

Find each endpoint registration block in `api.ts` and delete the block. Each block typically looks like:

```typescript
registerApiTrigger({
    function_id: "mem::claude-bridge-read",
    method: "GET",
    path: "/agentmemory/claude-bridge/read",
    handler: async (req) => { ... },
});
```

Delete all 8 blocks.

- [ ] **Step 3: Build + verify**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add src/triggers/api.ts && git commit -m "fix: remove 8 dead API endpoints for claude-bridge and graph (handlers removed in prior commit)"
```

---

### Task 4: Gate consolidation behind isConsolidationEnabled()

**Files:**
- Modify: `src/index.ts:278`

- [ ] **Step 1: Add gate**

```typescript
if (isConsolidationEnabled()) {
    registerConsolidationPipelineFunction(sdk, kv, provider);
    bootLog(`Consolidation pipeline: registered`);
} else {
    bootLog(`Consolidation pipeline: disabled (CONSOLIDATION_ENABLED=false)`);
}
```

- [ ] **Step 2: Build + verify**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts && git commit -m "fix: gate registerConsolidationPipelineFunction behind isConsolidationEnabled()"
```

---

### Task 5: Track legacy timers in _cleanupTimers

**Files:**
- Modify: `src/index.ts:543-592`

- [ ] **Step 1: For each legacy timer, push into _cleanupTimers**

Find the 5 legacy setInterval calls and add `.unref()` (already there) then `.push()` the handle.

Pattern for each:
```typescript
// auto-forget (line 544)
const autoForgetTimer = setInterval(async () => {
    try {
        await sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false } });
    } catch {}
}, autoForgetIntervalMs);
autoForgetTimer.unref();
_cleanupTimers.push(autoForgetTimer);  // ADD THIS LINE

// Same for lesson-decay, insight-decay, recent-searches-sweep, consolidation
```

- [ ] **Step 2: Build + verify**

```bash
cd ~/memory/agentmemory && npm run build 2>&1 | tail -3
```

- [ ] **Step 3: Deploy + commit**

```bash
cp dist/index.mjs $(npm root -g)/@agentmemory/agentmemory/dist/index.mjs
git add src/index.ts && git commit -m "fix: track all 5 legacy timers in _cleanupTimers for proper shutdown cleanup"
```
