# CLAUDE.md

Claude Code loads this file every session. **Canonical rules live in `AGENTS.md`** (imported below). This local block is a short fallback if imports are declined or unavailable, plus Claude-specific pointers.

## Local hard constraints (fallback)

- **Daemon**, not a library — agents connect via hooks / MCP / REST.
- **iii-sdk@0.11.2** only — do not upgrade past 0.11.2 until sandbox refactor.
- **Three primitives only**: `registerFunction` / `registerTrigger` / `sdk.trigger` — StateKV only; no Express/Fastify; no direct SQLite.
- **`TriggerAction.Void()`** for fire-and-forget — never `action: "void"`. Timers: `.unref()` + `_cleanupTimers[]`.
- **Whitelist** fields before `sdk.trigger()`; never pass raw request bodies.
- **Do not hand-edit** `dist/`, `dist/hooks/`, or `plugin/scripts/` — run `npm run build`.
- **Done gate**: `npm test`; after hooks → `npm run build`; after tools/API/env → `npm run skills:gen` && `npm run skills:check`.

## Commands (quick)

```bash
npm install && npm run dev
npm test
npx vitest run test/<file>.ts
npm run build
npm run skills:gen && npm run skills:check
bash scripts/status.sh
```

## Where to go next

| Need | File |
|------|------|
| Full agent entry (router + always-on + index) | `AGENTS.md` (also imported below) |
| Patterns, checklists, gotchas | `docs/agent-conventions.md` |
| Tests / CI / skills QA | `docs/agent-testing.md` |
| Deep architecture | `docs/architecture.md` |
| Install agentmemory on a user machine | `INSTALL_FOR_AGENTS.md` |

## Claude Code notes

- Prefer plan mode for multi-file registration changes (tools, REST counts, version bumps).
- If this is the first open of the project and Claude asks to approve imports, **allow `@AGENTS.md`** so the full entrypoint is inlined.

@AGENTS.md
