# agentmemory-backup.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 3 issues in `scripts/agentmemory-backup.sh`: AUTH word-split, exportData wrapper, ARG_MAX

**Architecture:** Single bash script. 3 fixes are tightly related (all in the curl invocations).

**Tech Stack:** bash, curl, jq

## Global Constraints

- All changes in `scripts/agentmemory-backup.sh`
- Must work with bash 4.0+
- Must handle spaces in AGENTMEMORY_SECRET

---

### Task 1: Fix AUTH array + import body + ARG_MAX (combine)

**Files:**
- Modify: `scripts/agentmemory-backup.sh:11-41`

**Interfaces:**
- Produces: Working backup/restore with `AGENTMEMORY_SECRET` set

- [ ] **Step 1: Read current script**

```bash
cat ~/memory/agentmemory/scripts/agentmemory-backup.sh
```

- [ ] **Step 2: Replace AUTH variable**

```bash
# Before:
AUTH="${AGENTMEMORY_SECRET:+-H \"Authorization: Bearer $AGENTMEMORY_SECRET\"}"

# After:
AUTH=()
[ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTMEMORY_SECRET")
```

- [ ] **Step 3: Fix export curl invocation**

```bash
# Before:
curl -s "$AGENTMEMORY_URL/agentmemory/export" $AUTH | python3 -m json.tool > "$FILE"

# After:
curl -s "$AGENTMEMORY_URL/agentmemory/export" "${AUTH[@]}" | python3 -m json.tool > "$FILE"
```

- [ ] **Step 4: Fix import curl invocation**

```bash
# Before:
curl -s -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  $AUTH \
  -d "$(cat "$FILE")"

# After:
curl -s -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  --data-binary "$(jq -nc --argjson data "$(cat "$FILE")" '{exportData: $data, strategy: "replace"}')"
```

- [ ] **Step 5: Verify export works**

```bash
cd ~/memory/agentmemory && chmod +x scripts/agentmemory-backup.sh
AGENTMEMORY_SECRET=omp-memory-local bash scripts/agentmemory-backup.sh export
```

Expected: File created in `~/.agentmemory/backups/` with valid JSON containing `{"exportData":..., "exportedAt":..., "sessions":[...], ...}`

- [ ] **Step 6: Verify import works**

```bash
# Get the latest backup file
FILE=$(ls -t ~/.agentmemory/backups/agentmemory-export-*.json | head -1)
AGENTMEMORY_SECRET=omp-memory-local bash scripts/agentmemory-backup.sh import "$FILE"
```

Expected: Output from server confirming import (no 401/400)

- [ ] **Step 7: Commit**

```bash
cd ~/memory/agentmemory && git add scripts/agentmemory-backup.sh && git commit -m "fix: backup.sh — bash array AUTH, exportData wrapper, --data-binary"
```
