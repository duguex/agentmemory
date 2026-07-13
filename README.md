<p align="center">
  <img src="assets/banner.png" alt="agentmemory — Persistent memory for AI coding agents" width="720" />
</p>

<p align="center">
  <strong>Persistent memory for AI coding agents</strong> — capture, compress, search, inject.<br/>
  Built on <a href="https://github.com/iii-hq/iii">iii engine</a> (pinned <strong>v0.11.2</strong>).
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="READMEs/README.zh-CN.md">简体中文</a> ·
  <a href="READMEs/README.zh-TW.md">繁體中文</a> ·
  <a href="READMEs/README.ja-JP.md">日本語</a> ·
  <a href="READMEs/README.ko-KR.md">한국어</a> ·
  <a href="READMEs/">more languages…</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agentmemory/agentmemory"><img src="https://img.shields.io/npm/v/@agentmemory/agentmemory?color=CB3837&label=npm&style=for-the-badge&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/rohitg00/agentmemory/actions"><img src="https://img.shields.io/github/actions/workflow/status/rohitg00/agentmemory/ci.yml?label=tests&style=for-the-badge&logo=github" alt="CI" /></a>
  <a href="https://github.com/rohitg00/agentmemory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rohitg00/agentmemory?color=blue&style=for-the-badge" alt="License" /></a>
</p>

---

## What this is

**agentmemory** is a **daemon** (not an app library) that gives coding agents cross-session memory:

1. Hooks / MCP / REST **capture** what the agent does  
2. Compresses into searchable memory (BM25 + vectors + optional graph)  
3. **Injects** the right context on the next session  

Works with Claude Code, Codex, Copilot CLI, Cursor, Gemini CLI, OpenCode, and any MCP/HTTP client. One server; shared memory.

**Not** a replacement for your LLM. **Not** an always-on second copy of `AGENTS.md` rules — product install lives here; **coding-agent rules for this repo** are in [`AGENTS.md`](AGENTS.md).

Package: `@agentmemory/agentmemory` · Node **≥20** · Apache-2.0 · version source: `package.json` / `src/version.ts`.

---

## Install (fast path)

**For coding agents installing agentmemory on a machine**, hand them:

> Retrieve and follow: https://raw.githubusercontent.com/rohitg00/agentmemory/main/INSTALL_FOR_AGENTS.md  

Local copy: [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md).

```bash
npm install -g @agentmemory/agentmemory   # bare `agentmemory` on PATH
# EACCES on system Node? retry with sudo, or use a user-owned Node prefix.

agentmemory                               # memory server (default REST :3111)
agentmemory demo                          # seed sample sessions + prove recall
agentmemory demo --serve                  # boot + demo + tear down (one terminal)
agentmemory connect claude-code           # wire an agent (also: copilot-cli, codex, cursor, …)
npx skills add rohitg00/agentmemory -y    # optional native skills
```

No global install:

```bash
npx -y @agentmemory/agentmemory@latest
npx -y @agentmemory/agentmemory demo
```

Already running a **different** `iii` engine? This package pins **iii-engine v0.11.2** and will not attach to another protocol version. Stop the other engine first, or use the version agentmemory installs under `~/.agentmemory/bin`.

**Windows:** prefer WSL2. Native Windows needs a manual iii binary (see long guide). `agentmemory connect` is limited there.

Viewer (auto): **http://localhost:3113**

---

## 30-second try

```bash
# Terminal 1
npx -y @agentmemory/agentmemory@latest

# Terminal 2
npx -y @agentmemory/agentmemory demo
```

`demo` seeds sample sessions and runs search. Open the viewer to watch memory build.

Useful CLI: `agentmemory stop` · `agentmemory doctor` · `agentmemory upgrade` · `agentmemory import-jsonl` · `agentmemory remove`.

---

## Ports (defaults)

| Port | Purpose | Override |
|------|---------|----------|
| **3111** | REST + MCP HTTP + health | `III_REST_PORT` |
| **3112** | iii streams worker | `III_STREAMS_PORT` |
| **3113** | Real-time viewer | `AGENTMEMORY_VIEWER_PORT` |
| **49134** | iii WebSocket / workers | `III_ENGINE_URL` |

Config file (preferred over shell exports): `~/.agentmemory/.env` (process env wins). Full variable list: [`.env.example`](.env.example) and [docs/user/guide.md](docs/user/guide.md)#configuration.

---

## How it works (short)

```text
PostToolUse → dedup + privacy filter → store observation
           → LLM compress → embed → BM25 + vector index
SessionStart → hybrid search under token budget → inject context
```

Four consolidation tiers: working → episodic → semantic → procedural. Details, MCP tool catalog, benchmarks, and competitor table: **[docs/user/guide.md](docs/user/guide.md)** (full former root README).

---

## Wire your agent (index)

| Path | Where |
|------|--------|
| One-shot agent install runbook | [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) |
| Claude / Codex / Copilot / Cursor / … paste blocks | [docs/user/guide.md](docs/user/guide.md) → *Works with every agent* / *Quick Start* |
| Standalone MCP only | `npx -y @agentmemory/agentmemory mcp` or `@agentmemory/mcp` |
| OMP / host integrations | [`integrations/`](integrations/) (e.g. `integrations/omp/README.md`) |

MCP clients typically point at `http://localhost:3111` via `AGENTMEMORY_URL`.

---

## Documentation map

| Audience | Start here |
|----------|------------|
| **Humans / operators (this page)** | Install, ports, pointers — **keep short** |
| **Full product guide** (benchmarks, all agents, MCP tools, config dump, API) | [`docs/user/guide.md`](docs/user/guide.md) |
| **Coding agents changing this repo** | [`AGENTS.md`](AGENTS.md) — **canonical rules** |
| Claude Code adapter | [`CLAUDE.md`](CLAUDE.md) — short + `@AGENTS.md` (**not** a second rulebook) |
| Conventions / testing / architecture | [`docs/README.md`](docs/README.md) |
| Design / site | [`DESIGN.md`](DESIGN.md), `website/` |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |
| Security | [`SECURITY.md`](SECURITY.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

**Authority:** agent coding rules → **AGENTS.md** only. This README is human product entry; agents may still read it for install UX.

---

## Develop from source

```bash
git clone <this-repo> && cd agentmemory
npm install
npm run dev          # tsx src/index.ts
npm test             # unit
npm run build && npm start
```

Engine pin, StateKV rules, checklists: [`AGENTS.md`](AGENTS.md) + [`docs/agent-conventions.md`](docs/agent-conventions.md).

---

## License

[Apache-2.0](LICENSE)

---

*Long-form English README content (marketing tables, full config comments, tool lists) lives in [`docs/user/guide.md`](docs/user/guide.md). Translated `READMEs/*` may still mirror an older monorepo layout — use English L1 + guide as source of truth until translations catch up.*
