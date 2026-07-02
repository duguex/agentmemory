# backfill-sessions.py Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 7 issues in `scripts/backfill-sessions.py`: toolCall schema, sessionId truncation, KeyboardInterrupt, limit parsing, double parse, OOM, TCP keepalive

**Architecture:** Single Python script. Fixes are local to `parse_session()` and `main()`. No new files.

**Tech Stack:** Python 3, requests, jsonl

## Global Constraints

- All changes in `scripts/backfill-sessions.py`
- No new dependencies
- Backward compatible with existing JSONL format

---

### Task 1: Fix toolCall schema — parse from msg.content[]

**Files:**
- Modify: `scripts/backfill-sessions.py:170-195`

**Interfaces:**
- Consumes: OMP JSONL format where `msg.content` entries have `{type: "toolCall", id, name, arguments}`
- Produces: Correctly parsed tool calls in timeline

- [ ] **Step 1: Read current assistant parsing code**

```bash
grep -n "toolCalls\|role == \"assistant\"" ~/memory/agentmemory/scripts/backfill-sessions.py
```

- [ ] **Step 2: Replace tool call detection**

Current code reads `msg.get("toolCalls", [])` — change to extract from `msg.content[]`:

```python
# Parse tool calls from content array (OMP JSONL schema)
tool_calls = []
for part in msg.get("content", []):
    if isinstance(part, dict) and part.get("type") == "toolCall":
        inp = json.dumps(part.get("arguments", {}), ensure_ascii=False)
        tool_calls.append({
            "type": "tool_call",
            "name": part.get("name", "unknown"),
            "input": inp,
            "id": part.get("id"),
            "assistant_ts": ts,
            "assistant_text": text,
        })
```

Replace the `pending_tool_calls` block with these parsed tool_calls.

- [ ] **Step 3: Run dry-run to verify parsing**

```bash
cd ~/memory/agentmemory && AGENTMEMORY_SECRET=omp-memory-local python3 scripts/backfill-sessions.py --dry-run --limit=3
```

Expected: Correct tool call counts (previously 0 for sessions that had tools)

- [ ] **Step 4: Commit**

```bash
cd ~/memory/agentmemory && git add scripts/backfill-sessions.py && git commit -m "fix: parse toolCall from msg.content[] (OMP schema) instead of msg.toolCalls"
```

---

### Task 2: sessionId truncation fix

**Files:**
- Modify: `scripts/backfill-sessions.py:363`

- [ ] **Step 1: Remove the truncation**

```python
"sessionId": f"backfill-{session_meta['id']}",
```

- [ ] **Step 2: Verify dry-run works**

```bash
cd ~/memory/agentmemory && AGENTMEMORY_SECRET=omp-memory-local python3 scripts/backfill-sessions.py --dry-run --limit=1
```

- [ ] **Step 3: Commit**

```bash
cd ~/memory/agentmemory && git add scripts/backfill-sessions.py && git commit -m "fix: use full session ID, remove 20-char truncation"
```

---

### Task 3: Bare except → specific exceptions

**Files:**
- Modify: `scripts/backfill-sessions.py` (find `except:`)

- [ ] **Step 1: Find and replace bare except**

```bash
grep -n "except:" ~/memory/agentmemory/scripts/backfill-sessions.py
```

```python
# Before:
        except:
            obs_ts = datetime.now(timezone.utc).isoformat()
# After:
        except (ValueError, TypeError):
            obs_ts = datetime.now(timezone.utc).isoformat()
```

- [ ] **Step 2: Commit**

```bash
git commit -m "fix: replace bare except with (ValueError, TypeError) to not swallow KeyboardInterrupt"
```

---

### Task 4: --limit parse protection

**Files:**
- Modify: `scripts/backfill-sessions.py:280`

- [ ] **Step 1: Wrap int() in try/except**

```python
try:
    limit = int(arg.split("=", 1)[1])
except (ValueError, IndexError):
    print(f"Error: --limit requires a positive integer, got '{arg.split('=', 1)[1] if '=' in arg else ''}'")
    sys.exit(1)
```

- [ ] **Step 2: Commit**

```bash
git commit -m "fix: protect --limit parse with try/except ValueError"
```

---

### Task 5: Remove double parse for stats

**Files:**
- Modify: `scripts/backfill-sessions.py:394-404`

- [ ] **Step 1: Add projects accumulator in main loop and remove re-parse**

In the main loop, before `for i, fpath in enumerate(session_files):`:
```python
projects = {}
```

Inside the loop, after successful parse:
```python
projects[session_meta["project"]] = projects.get(session_meta["project"], 0) + len(turns)
```

After the loop, replace the re-parse block with:
```python
print("Per-project summary:")
for p, count in sorted(projects.items(), key=lambda x: -x[1]):
    print(f"  {p:20s} {count:5d} turns")
```

Delete lines 394-404 (the re-iteration block).

- [ ] **Step 2: Dry-run to verify stats still work**

```bash
cd ~/memory/agentmemory && AGENTMEMORY_SECRET=omp-memory-local python3 scripts/backfill-sessions.py --dry-run --limit=5
```

- [ ] **Step 3: Commit**

```bash
git commit -m "perf: accumulate project stats in main loop, remove double parse"
```

---

### Task 6: Stream JSONL instead of reading all lines

**Files:**
- Modify: `scripts/backfill-sessions.py:122-123`

- [ ] **Step 1: Change to streaming**

```python
with open(filepath, "r", encoding="utf-8", errors="replace") as f:
    entries = []
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
```

Then use `entries[0]` for session meta and `entries[1:]` for timeline.

- [ ] **Step 2: Commit**

```bash
git commit -m "perf: stream JSONL lines instead of reading all into memory"
```

---

### Task 7: Use requests.Session() for keepalive

**Files:**
- Modify: `scripts/backfill-sessions.py:56-63`

- [ ] **Step 1: Add module-level session**

After imports, add:
```python
_http_session: requests.Session | None = None
```

In `api_post()`:
```python
def api_post(path, body):
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
    url = f"{AGENTMEMORY_URL.rstrip('/')}/agentmemory/{path}"
    try:
        r = _http_session.post(url, headers=auth_headers(), json=body, timeout=15)
        return r.ok
    except Exception as e:
        print(f"  [error] {e}")
        return False
```

- [ ] **Step 2: Commit**

```bash
git commit -m "perf: use requests.Session() for TCP keepalive"
```
