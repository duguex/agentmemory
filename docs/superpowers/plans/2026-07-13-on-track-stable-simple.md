# Agentmemory On-Track Plan (稳 + 简)

> **For agentic workers:** implement **one phase at a time**. Do not open the next phase until the current phase’s **Exit criteria** are met. Prefer `scripts/am-daemon.sh` for all runtime ops. Checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agentmemory a **reliable local coding-agent memory** that stays up, is operable by one script, and **provably helps real coding work**—without more queue/engine over-design.

**Architecture:** Keep iii-engine 0.11.2 + Node worker. Ops surface is **supervised process tree** (`AGENTMEMORY_SUPERVISED=1`, `scripts/am-daemon.sh`, optional user systemd). Product surface is **observe → store/index → search/recall → optional inject**. LLM chat stays **single-flight** (`llm-gate`). No second “LLM job queue” abstraction.

**Tech stack:** Node ≥20, `iii-sdk@0.11.2`, iii-engine binary 0.11.2, Vitest, Ollama/local OpenAI-compatible chat + embed, bash ops scripts under `scripts/`.

## Global Constraints

- **稳 + 简 over features.** If a change is not required for “alive + useful recall,” defer it.
- **Ops only via** `bash scripts/am-daemon.sh {start,stop,restart,status,ensure,health}` (or `systemctl --user` for the same unit). **Forbidden for daily use:** `nohup … > daemon.log` (truncate), partial `pkill`.
- **Engine pin:** `iii-sdk` / iii binary **0.11.2** — do not bump to 0.11.6+ in this plan.
- **Chat LLM:** keep global serial gate (`src/providers/llm-gate.ts` + `ResilientProvider`). Do not reintroduce priority LLM queues.
- **Working directory for exec worker:** package root with `dist/` + `iii-config.yaml` (repo: `/home/duguex/memory/agentmemory` or install root that contains `dist/`).
- **Logs:** append-only `~/.agentmemory/logs/daemon.log` (rotation in `am-daemon.sh`).
- **Success metrics must be measurable** (commands below). No vibe-based “feels better.”
- **Out of scope for this plan:** SSO, RBAC, multi-tenant mesh, iii major upgrade, cloud SaaS, new connectors, multimodal expansion, priority queues, multi-concurrency chat on local 35B.

## North star (definition of “正轨”)

All of the following are true for **7 consecutive days** of normal use:

1. **Alive:** `bash scripts/am-daemon.sh health` exits 0 after cold boot and after overnight.
2. **No half-dead:** never “iii up + livez 404 / workers=0” without auto-heal within 2 minutes (`agentmemory-ensure.timer` or manual `ensure`).
3. **Useful:** ≥ **3/5** fixed real queries return relevant memory **and** (if inject on) agent sessions need less re-explanation on those topics.
4. **Operable by one person:** start/stop/status documented in one place; no ad-hoc process archaeology.

If (3) fails after Phase B effort → **gate to thin path** (see Phase Z), do not dig more architecture.

## Freeze list (do not work on until Phase D+)

- LLM priority queues / `llm-queue` revival  
- Batch compress redesign (unless Phase D explicitly opened)  
- iii version upgrade / sandbox worker model  
- New MCP tools, new agents, website polish  
- Enterprise roadmap items (SSO, audit export, RBAC)  
- Re-litigating compress success-rate cosmetics while alive+useful is red  

## Already done (Phase A baseline) — 2026-07-13

- [x] `scripts/am-daemon.sh` — full tree start/stop/restart/status/ensure/health  
- [x] `AGENTMEMORY_SUPERVISED=1` — iii not detached (`src/cli.ts`)  
- [x] True health = HTTP workers ≥1 **and** process tree  
- [x] Append log + rotate; health/status point at `~/.agentmemory/logs/daemon.log`  
- [x] User systemd unit + `agentmemory-ensure.timer` (2 min)  
- [x] LLM gate simplified (Route S); no priority queue  

**Verify anytime:**

```bash
bash scripts/am-daemon.sh status
# expect: iii PPID = agentmemory CLI (not always 1 for iii)
# expect: true health ok workers≥1
rg "supervised: not detached" ~/.agentmemory/logs/daemon.log | tail -3
```

---

## Phase map (order is mandatory)

```text
A  Ops foundation     [DONE]
B  E2E usefulness     [DONE 2026-07-13 — GO 5/5 search, inject path-ok → Phase C]
C  Single registration / half-dead residual  [DONE 2026-07-13 — C-cli, workers=1, iii-config.supervised.yaml]
D  Retrieval honesty (obs-level GT optional; session sufficient for inject)
E  Load & cost (compress/VRAM) only if B+C green and backlog hurts daily use
Z  Thin-path exit     if B fails the gate
```

Timeline (calendar, single maintainer):

| Phase | Duration | Outcome |
|-------|----------|---------|
| B | 2–4 days | Go / no-go on product value |
| C | 2–3 days | One clear worker story; fewer ghost registrations |
| D | 3–5 days | Honest search quality signal for *your* corpus |
| E | 0–1 week | Only if needed |
| Z | 1 day decision | Freeze or thin |

---

## Phase B — E2E usefulness gate (NEXT)

**Goal:** Prove memory helps **this** machine’s coding work, or stop investing.

**Architecture:** Use existing REST/MCP; no new subsystems. Hooks already POST observe; search via `mem::smart-search` / MCP `memory_smart_search` / `memory_recall`. Inject via `AGENTMEMORY_INJECT_CONTEXT=true` when testing agent path.

### Task B1: Freeze a 5-query scorecard

**Files:**
- Create: `docs/superpowers/plans/e2e-scorecard.md` (or `benchmark/local-e2e-queries.md`)
- Read: `benchmark/backfill-quality-eval.ts` (method inspiration only)

- [ ] **Step 1:** Write 5 queries you actually care about (project decisions, paths, failure modes)—not generic LongMemEval text.
- [ ] **Step 2:** For each, note expected session id or keyword (hand label).
- [ ] **Step 3:** Table columns: `query | expected | hit? | top session/obs | inject tried? | reduced re-explain?`

Example skeleton:

```markdown
| # | Query | Expected cue | Hit | Notes |
|---|-------|--------------|-----|-------|
| 1 | … | … | ☐ | |
```

### Task B2: Search-only measurement (no inject yet)

**Files:** none required (curl / CLI)

- [ ] **Step 1:** Ensure daemon healthy:

```bash
bash scripts/am-daemon.sh health
```

Expected: exit 0, `ok workers=…`

- [ ] **Step 2:** For each query, call smart-search (adjust secret/url):

```bash
SECRET="${AGENTMEMORY_SECRET:-omp-memory-local}"
curl -sS -m 60 -H "Authorization: Bearer $SECRET" -H "Content-Type: application/json" \
  -d '{"query":"YOUR QUERY HERE","limit":10}' \
  http://localhost:3111/agentmemory/smart-search | python3 -m json.tool | head -80
```

- [ ] **Step 3:** Mark Hit if top-10 contains expected cue/session.
- [ ] **Step 4:** Score: hits / 5. Record in scorecard.

**Exit B2:** scorecard filled for search-only.

### Task B3: Inject path (agent path)

**Files:**
- Modify (env only): `~/.agentmemory/.env`
- Read: hook docs / `AGENTMEMORY_INJECT_CONTEXT` in `.env.example`

- [ ] **Step 1:** Set:

```bash
# in ~/.agentmemory/.env
AGENTMEMORY_INJECT_CONTEXT=true
```

- [ ] **Step 2:** `bash scripts/am-daemon.sh restart` and confirm health.
- [ ] **Step 3:** Run one real agent session per failed or borderline query topic; note whether context appears / re-explain drops.
- [ ] **Step 4:** Update scorecard column `reduced re-explain?`

### Task B4: Gate decision

- [ ] **If ≥3/5 search hits AND inject path not broken → Phase C.**  
- [ ] **If ≥3/5 search hits but inject broken → fix inject only (small bugfix), re-test B3, then C.**  
- [ ] **If &lt;3/5 search hits → Phase D before C, or Phase Z if you refuse more retrieval work.**  
- [ ] **If process flaky during B → stop product work; re-open Phase A regressions only.**

**Phase B Exit criteria:**
- [ ] Scorecard committed or saved under `docs/superpowers/plans/`
- [ ] Written go/no-go line in that file
- [ ] `am-daemon.sh health` still green

---

## Phase C — Single worker story (half-dead residual)

**Goal:** One understandable process registration model; stop “workers: 2” ambiguity and orphan registrations.

**Problem today:** CLI `import("./index.js")` **and** iii-exec `node dist/index.mjs` → dual workers; known-issues #5 stale registrations.

**Architecture choice (pick one, implement fully):**

| Option | Behavior |
|--------|----------|
| **C-exec** | Worker only via iii-exec; CLI starts engine then **exits** or only supervises (harder with current CLI) |
| **C-cli** | Worker only via CLI import; iii-config **exec removed/disabled** under supervised installs |
| **C-status-quo+doc** | Keep dual but document + ensure kill tree (weaker; only if C-exec/C-cli blocked) |

**Recommended default: C-cli** for supervised local installs (one Node that systemd/am-daemon tracks).

### Task C1: Decide and document

**Files:**
- Modify: `docs/architecture.md` (process table)
- Modify: `docs/known-issues.md` #5 status

- [x] **Step 1:** Write decision: C-cli / C-exec / C-status-quo+doc + one-paragraph why.
- [x] **Step 2:** Update architecture process diagram to match.

**Decision: C-cli.** Worker registers only via CLI `import("./index.js")`. iii-exec (`node dist/index.mjs`) is disabled in supervised config. Rationale: systemd/am-daemon tracks one Node process; SUPERVISED=1 keeps iii as a child of the CLI, so no dual/spontaneous worker registrations. C-exec would require restructuring CLI startup contracts; C-status-quo+doc would leave the half-dead risk unresolved. Planned implementation in Phase C2.

### Task C2: Implement C-cli (if chosen)

**Files:**
- Modify: `iii-config.yaml` (or supervised overlay config) — remove/disable `iii-exec` watch+exec for local supervised path
- Modify: `src/cli.ts` only if config path selection needs `AGENTMEMORY_III_CONFIG`
- Test: manual process tree + health

- [ ] **Step 1:** Add `iii-config.supervised.yaml` **or** env-selected config without:

```yaml
# omit or empty iii-exec worker so only CLI-imported worker registers
```

- [ ] **Step 2:** Point supervised start at that config (`AGENTMEMORY_III_CONFIG=...` already supported in cli).
- [ ] **Step 3:** Wire `am-daemon.sh` / systemd `Environment=AGENTMEMORY_III_CONFIG=...`
- [ ] **Step 4:** Restart and verify:

```bash
bash scripts/am-daemon.sh restart
bash scripts/am-daemon.sh status
# expect: workers=1 (health), one node agentmemory, iii child, NO dist/index.mjs OR only one worker in health
curl -sS -H "Authorization: Bearer $SECRET" http://localhost:3111/agentmemory/health | python3 -c "import sys,json; print(len(json.load(sys.stdin)['health']['workers']))"
```

Expected: `1`

- [ ] **Step 5:** Kill only CLI; confirm iii dies with it when SUPERVISED=1 (or ensure heals within 2 min).

### Task C3: Ensure timer still correct

- [ ] **Step 1:** `systemctl --user status agentmemory-ensure.timer`
- [ ] **Step 2:** Simulate half-dead only if safe on this machine; prefer code review of `ensure` path using systemctl when unit active.

**Phase C Exit criteria:**
- [ ] Documented single-worker decision  
- [ ] Normal boot shows **workers=1** (or documented exception)  
- [ ] `am-daemon.sh stop` leaves **zero** agentmemory/iii/index processes  

---

## Phase D — Retrieval honesty (your corpus)

**Goal:** Trust search numbers on **local** data; enough for inject quality, not leaderboard vanity.

**Files:**
- `benchmark/backfill-quality-eval.ts`
- optional GT json used by that script
- `docs/known-issues.md` #3

### Task D1: Session-level is enough for inject?

- [ ] **Step 1:** Re-run existing session eval:

```bash
cd /home/duguex/memory/agentmemory
npx tsx benchmark/backfill-quality-eval.ts 2>&1 | tail -40
```

- [ ] **Step 2:** Compare to known baseline session R@10 ≈ 93.8% (2026-07-12). If collapsed, debug index/embed before obs labels.

### Task D2: Align eval with Phase B queries

- [ ] **Step 1:** Add Phase B’s 5 queries into local GT (session labels minimum).
- [ ] **Step 2:** Re-run eval; store output path in scorecard.

### Task D3: Obs-level only if inject needs snippets

- [ ] **Step 1:** If agents only need session summaries, **skip** obs GT (mark known-issues #3 deferred).  
- [ ] **Step 2:** If agents need exact obs quotes, add 2–5 `relevantObservations` per query; re-run.

**Phase D Exit criteria:**
- [ ] Reproducible command + number checked into scorecard or IMPROVEMENTS  
- [ ] No claim of obs R@ without labels  

---

## Phase E — Load & cost (optional)

**Open only if:** Phase B go **and** daily pain is queue depth / VRAM, not recall quality.

**Allowed work:**
- `OLLAMA_KEEP_ALIVE` policy (known-issues #2)  
- Document “accept VRAM hold while depth&gt;0”  
- **Not** multi-concurrency local 35B chat  
- Batch compress only with a written budget and kill criteria  

**Exit:** depth drains under normal observe rate without daily manual DLQ theatre; or accept status quo in writing.

---

## Phase Z — Thin-path exit (if B fails)

**Goal:** Stop paying agentmemory ops tax if memory does not help.

1. Freeze feature work; leave daemon read-only or stop.  
2. Export anything valuable (`memory_export` / data dir backup via `scripts/agentmemory-backup.sh`).  
3. Use agent built-in memory + optional thin MCP (Mem0 self-host or 7-tool shim only).  
4. One-page postmortem: what failed (ops vs retrieval vs inject).  

Do **not** start a multi-week rewrite of agentmemory on a different engine in the same breath.

---

## Weekly operating cadence (while on this plan)

| Cadence | Action |
|---------|--------|
| Daily | `bash scripts/am-daemon.sh health` (or trust ensure timer + glance status) |
| After code change | `npm run build` → rsync/install dist if using global bin → `am-daemon.sh restart` → health |
| Before claiming “fixed” | health + one scorecard query |
| Never | Partial pkill; log truncate; new abstraction without Phase gate |

## Definition of done for “项目正轨”

- [ ] Phase B go  
- [ ] Phase C workers story clean  
- [ ] 7-day alive streak  
- [ ] Freeze list still frozen  
- [ ] One ops entrypoint only  

---

## Self-review (plan vs need)

| Need | Covered by |
|------|------------|
| 稳 | A done, C, cadence, ensure timer |
| 简 | Freeze list, single ops script, no dual queue |
| 有用 | Phase B gate, D honesty |
| 不转圈 | Phase order mandatory; Z exit |
| iii reality | pin 0.11.2; no fairy-tale “remove iii this month” |

---

## Execution handoff

**Plan saved to:** `docs/superpowers/plans/2026-07-13-on-track-stable-simple.md`

**Recommended next action:** execute **Phase B only** (scorecard + 5 queries + gate).

**Two ways to run later implementation phases:**

1. **Subagent-driven** — one phase/task per subagent, review between  
2. **Inline** — same session, checkpoint after each task  

**Do not start Phase C/D/E until B’s go/no-go is written down.**
