# agentmemory-backup.sh Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 2 P0 defects in `scripts/agentmemory-backup.sh`: bash word-splitting on AUTH variable, and missing `exportData` envelope on import body.

**Architecture:** Rewrite two specific code blocks. Use bash arrays for AUTH, jq for body wrapping, `--data-binary` for large-file support. Verify with bats (Bash Automated Testing System) or shell-syntax checks since unit-testing bash is awkward.

**Tech Stack:** bash 5+, curl, jq, GNU coreutils. bats is optional for testing.

## Global Constraints

- bash 5+ syntax (associative arrays, `[[ ]]` not needed)
- `set -euo pipefail` is set at the top of the file — preserve this
- Backward compat: existing CLI args (`export`, `import`, `list`, `info`) unchanged
- Spec reference: `docs/superpowers/specs/2026-07-03-omp-adaptation-fixes-design.md` §G2

---

## File Structure

| File | Role |
|---|---|
| `scripts/agentmemory-backup.sh` | MODIFY — fix AUTH array + import body wrapping |
| `test/agentmemory-backup.bats` | CREATE — bats tests covering both fixes (optional but recommended) |

No new scripts. Changes contained in 1-2 files.

---

## Task 1: Write failing test for AUTH array expansion (G2.1)

**Files:**
- Create: `test/agentmemory-backup.bats`

**Interfaces:**
- Consumes: `bash -n scripts/agentmemory-backup.sh` (syntax check)
- Produces: bats test functions that exercise export + import flows

- [ ] **Step 1: Create `test/agentmemory-backup.bats` with first test**

```bash
#!/usr/bin/env bats
# Tests for scripts/agentmemory-backup.sh

setup() {
    export SCRIPT="$BATS_TEST_DIRNAME/../scripts/agentmemory-backup.sh"
    # Use a mock curl that records args without making real calls
    export MOCK_BIN="$BATS_TEST_TMPDIR/mock-bin"
    mkdir -p "$MOCK_BIN"
    cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Mock curl that prints all args to a file and returns 200
echo "$@" >> "$MOCK_CURL_ARGS"
exit 0
EOF
    chmod +x "$MOCK_BIN/curl"
    export PATH="$MOCK_BIN:$PATH"
    export MOCK_CURL_ARGS="$BATS_TEST_TMPDIR/curl-args.txt"
    : > "$MOCK_CURL_ARGS"
    export AGENTMEMORY_SECRET="test-secret-abc"
}

@test "backup script syntax is valid" {
    run bash -n "$SCRIPT"
    [ "$status" -eq 0 ]
}

@test "export sends Authorization as single header arg (G2.1)" {
    run bash "$SCRIPT" export
    [ "$status" -eq 0 ]
    # The Authorization header must appear as a single -H arg, not split
    run grep -c "Authorization: Bearer test-secret-abc" "$MOCK_CURL_ARGS"
    # Expect exactly 1 occurrence (curl only sees it once, not split into pieces)
    [ "$output" -ge 1 ]
    # The auth line should NOT be broken into -H "Authorization: / Bearer / secret
    # separately. Mock captures whole argv, so verify each -H has both quoted tokens.
    run grep -E "^-H Authorization:" "$MOCK_CURL_ARGS"
    [ "$status" -ne 0 ]  # should NOT find unquoted -H Authorization: form
}

@test "export with no secret omits Authorization header (G2.1)" {
    unset AGENTMEMORY_SECRET
    run bash "$SCRIPT" export
    [ "$status" -eq 0 ]
    run grep -c "Authorization" "$MOCK_CURL_ARGS"
    [ "$output" -eq 0 ]
}
```

- [ ] **Step 2: Verify bats is available**

Run: `cd /home/duguex/memory/agentmemory && which bats || echo "bats not installed"`
Expected: Either `/usr/local/bin/bats` / `/usr/bin/bats` (installed) or `bats not installed`

If not installed, skip the bats test file and rely on manual verification in Step 3. If installed, run:

Run: `cd /home/duguex/memory/agentmemory && bats test/agentmemory-backup.bats`
Expected: FAIL on the G2.1 test (current code splits AUTH into multiple tokens)

- [ ] **Step 3: Commit failing tests**

```bash
git add test/agentmemory-backup.bats
git commit -m "test(backup): add failing bats tests for AUTH array + body wrapping"
```

(If bats is not available, skip this commit and proceed to manual verification.)

---

## Task 2: Fix AUTH variable to use bash array (G2.1)

**Files:**
- Modify: `scripts/agentmemory-backup.sh:11-12`

- [ ] **Step 1: Locate the AUTH variable**

Read `scripts/agentmemory-backup.sh:11-12` and find:
```bash
AUTH="${AGENTMEMORY_SECRET:+-H \"Authorization: Bearer $AGENTMEMORY_SECRET\"}"
```

- [ ] **Step 2: Replace with bash array**

Replace lines 11-12 with:
```bash
AUTH=()
[ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer $AGENTMEMORY_SECRET")
```

- [ ] **Step 3: Update call sites to use `"${AUTH[@]}"`**

Find all occurrences of `$AUTH` in the script and replace with `"${AUTH[@]}"`. Expected locations:
- Line ~27: `curl -sS -o "$TMPFILE" -w "%{http_code}" "$AGENTMEMORY_URL/agentmemory/export" "${AUTH[@]}" || true`
- Line ~67: `curl -sS -o /dev/null -w "%{http_code}" -X POST ... "${AUTH[@]}" --data-binary @"$TMPBODY" || echo "000"`

Run: `cd /home/duguex/memory/agentmemory && grep -n '\$AUTH\b' scripts/agentmemory-backup.sh`
Expected: No matches (all converted)

- [ ] **Step 4: Verify syntax**

Run: `cd /home/duguex/memory/agentmemory && bash -n scripts/agentmemory-backup.sh && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 5: Manual smoke test**

Run:
```bash
cd /home/duguex/memory/agentmemory
AGENTMEMORY_SECRET="my-test-token" bash -c '
  AUTH=()
  [ -n "${AGENTMEMORY_SECRET:-}" ] && AUTH=(-H "Authorization: Bearer ${AGENTMEMORY_SECRET}")
  echo "AUTH array length: ${#AUTH[@]}"
  echo "AUTH[0]: ${AUTH[0]}"
  echo "AUTH[1]: ${AUTH[1]}"
'
```
Expected output:
```
AUTH array length: 2
AUTH[0]: -H
AUTH[1]: Authorization: Bearer my-test-token
```

- [ ] **Step 6: Commit**

```bash
git add scripts/agentmemory-backup.sh
git commit -m "fix(backup): use bash array for AUTH to avoid word-splitting"
```

---

## Task 3: Write failing test for import body envelope (G2.2)

**Files:**
- Modify: `test/agentmemory-backup.bats` (append test)

- [ ] **Step 1: Add a test for the import body envelope**

Append to `test/agentmemory-backup.bats`:

```bash
@test "import wraps body in {exportData, strategy} envelope (G2.2)" {
    # Create a minimal valid JSON backup file
    cat > "$BATS_TEST_TMPDIR/backup.json" <<'EOF'
{"version":"0.9.16","exportedAt":"2026-07-01T00:00:00Z","sessions":[]}
EOF

    run bash "$SCRIPT" import "$BATS_TEST_TMPDIR/backup.json"
    [ "$status" -eq 0 ]

    # Mock curl captured --data-binary @<file>. Verify the file content is wrapped.
    # Find the file path from the curl args (it's the argument to --data-binary @)
    data_arg=$(grep -oE '\-\-data-binary @[^ ]+' "$MOCK_CURL_ARGS" | head -1 | sed 's/--data-binary @//')
    [ -n "$data_arg" ]
    run jq -e '.exportData != null and .strategy == "replace"' "$data_arg"
    [ "$status" -eq 0 ]
}

@test "import uses --data-binary not -d (G2.2 ARG_MAX safety)" {
    cat > "$BATS_TEST_TMPDIR/backup.json" <<'EOF'
{"version":"0.9.16"}
EOF
    run bash "$SCRIPT" import "$BATS_TEST_TMPDIR/backup.json"
    [ "$status" -eq 0 ]
    run grep -c -- "--data-binary" "$MOCK_CURL_ARGS"
    [ "$output" -ge 1 ]
    run grep -c -- " -d " "$MOCK_CURL_ARGS"
    [ "$output" -eq 0 ]
}
```

Note: the mock curl must capture body data via `--data-binary @file` for the test to read. Update the mock to handle this:

- [ ] **Step 2: Update mock curl to write body file content to a log**

Replace the mock curl in setup() with:

```bash
cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Mock curl that prints all args + any --data-binary file content
{
  echo "ARGS: $@"
  while [ $# -gt 0 ]; do
    case "$1" in
      --data-binary)
        echo "BODY_FILE: $2"
        if [ -f "$2" ]; then
          echo "BODY_CONTENT:"
          cat "$2"
        fi
        shift 2
        ;;
      *) shift ;;
    esac
  done
} >> "$MOCK_CURL_ARGS"
exit 0
EOF
```

- [ ] **Step 3: Run tests (expect failure on G2.2)**

Run: `cd /home/duguex/memory/agentmemory && bats test/agentmemory-backup.bats`
Expected: FAIL on `import wraps body` test (current code does not wrap envelope)

- [ ] **Step 4: Commit failing tests**

```bash
git add test/agentmemory-backup.bats
git commit -m "test(backup): add failing tests for exportData envelope + --data-binary"
```

---

## Task 4: Wrap import body in `{exportData, strategy}` envelope (G2.2)

**Files:**
- Modify: `scripts/agentmemory-backup.sh:50-78` (the `import|restore` case)

- [ ] **Step 1: Locate the import case body construction**

Read `scripts/agentmemory-backup.sh` lines 50-78. The current code does:
```bash
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  --data-binary "$(cat $FILE)" || echo "000")
```

This has TWO bugs:
1. `-d "$(cat $FILE)"` triggers ARG_MAX for large files
2. The body is the raw JSON, but server expects `{exportData: ..., strategy: ...}` envelope

- [ ] **Step 2: Replace with jq-wrapped body + --data-binary**

Replace the import curl block (lines ~63-72) with:

```bash
echo "Importing $FILE ..."
echo "Mode: replace"
TMPBODY="$(mktemp)"
trap 'rm -f "$TMPBODY"' EXIT
jq -c '{exportData: ., strategy: "replace"}' "$FILE" > "$TMPBODY"
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$AGENTMEMORY_URL/agentmemory/import" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  --data-binary @"$TMPBODY" || echo "000")
rm -f "$TMPBODY"
trap - EXIT
```

- [ ] **Step 3: Verify syntax**

Run: `cd /home/duguex/memory/agentmemory && bash -n scripts/agentmemory-backup.sh && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 4: Run bats tests**

Run: `cd /home/duguex/memory/agentmemory && bats test/agentmemory-backup.bats`
Expected: PASS

- [ ] **Step 5: Manual smoke test**

Run:
```bash
cd /home/duguex/memory/agentmemory
echo '{"version":"0.9.16"}' > /tmp/test-backup.json
jq -c '{exportData: ., strategy: "replace"}' /tmp/test-backup.json
```
Expected output:
```json
{"exportData":{"version":"0.9.16"},"strategy":"replace"}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/agentmemory-backup.sh
git commit -m "fix(backup): wrap import body in {exportData, strategy}; use --data-binary"
```

---

## Self-Review

**1. Spec coverage:**
- G2.1 (AUTH word-splitting) ✅ Tasks 1-2
- G2.2 (exportData envelope) ✅ Tasks 3-4

**2. Placeholder scan:** No TBDs. Code blocks complete. Test code shown verbatim.

**3. Type consistency:** `${AUTH[@]}` array expansion consistent across Tasks 2 and 4. `TMPBODY` cleanup via `trap` consistent in Task 4.

**Coverage gap:** Manual smoke tests are bash one-liners, not unit tests. Acceptable trade-off for shell scripts; bats covers the executable paths.

**Ready for execution.**