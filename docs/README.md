# docs/ 入口

> agentmemory 项目文档的导航页。

## 核心文档

| 文档 | 答什么问题 | 更新频率 |
|---|---|---|
| [`architecture.md`](./architecture.md) | 系统由什么组成?数据怎么流? | 架构变化时 |
| [`agent-conventions.md`](./agent-conventions.md) | Agent/贡献者改代码时的约定、清单、依赖与 gotchas | 约定变化时 |
| [`agent-testing.md`](./agent-testing.md) | 测试、CI、eval、skills QA | 测试体系变化时 |
| [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) | 过去改了什么?为什么改? | 每次 commit 后 |
| [`known-issues.md`](./known-issues.md) | 现在还有什么问题?怎么修? | 问题变化时 |
| [`final_purpose.md`](./final_purpose.md) | 最初想做什么?做到了吗? | 阶段结束时 |

## 推荐阅读顺序

按用途:

- **新人加入项目** → `architecture.md` → `agent-conventions.md` 扫一眼 → known-issues / IMPROVEMENTS 按需
- **coding agent 改代码** → 根目录 `AGENTS.md`（短入口）→ 按任务读 `agent-conventions.md` / `agent-testing.md`
- **OMP 注入怎么开** → [`../integrations/omp/README.md`](../integrations/omp/README.md) + `architecture.md`「OMP 注入」节
- **是否真有用** → [`superpowers/plans/2026-07-13-usefulness-trial.md`](./superpowers/plans/2026-07-13-usefulness-trial.md)
- **稳+简正轨计划** → [`superpowers/plans/2026-07-13-on-track-stable-simple.md`](./superpowers/plans/2026-07-13-on-track-stable-simple.md)
- **想看最近的改动** → IMPROVEMENTS.md (按 phase 倒序读最新)
- **想看还有什么是 broken** → known-issues.md

按紧急度:

- **出问题先看** → `bash ../scripts/am-daemon.sh health` / `status`，再看 architecture「已知限制」与 known-issues
- **想改代码** → IMPROVEMENTS.md 找相关 phase, 再看 known-issues.md

## 其他文档

- `superpowers/plans/` — 正轨计划、有用性检验、历史实现计划
- `../.superpowers/sdd/embed-compare-2026-07-13.json` — 本机 embedding 对照原始结果（nomic vs v2-moe vs qwen3）
- `../integrations/omp/README.md` — OMP 扩展 env 与 CLI 验收
- `recipes/` — 实用配方
- `benchmarks/` — 历史 benchmark 报告
- `issues/` / `reviews/` — 本地 issue 与 review


## 文档维护规则

- 核心文档**互相引用**, 不要在多个文档里说同一件事
- **Agent 规则单源**: 根目录 `AGENTS.md` 为唯一完整 always-on 正文；`CLAUDE.md` = 短本地摘要 + `@AGENTS.md`（无第二全文）
- 改代码 → 更新 IMPROVEMENTS.md
- 发现新问题 → 更新 known-issues.md (open 部分)
- 改架构 → 更新 architecture.md
- 改约定/清单 → 更新 agent-conventions.md（并确认 AGENTS.md 索引仍准确）
- 改测试/CI 习惯 → 更新 agent-testing.md
- 目标变化 → 更新 final_purpose.md

## 另见

- `../AGENTS.md` — agent 入口（路由器 + 硬规则）
- `../CLAUDE.md` — Claude 适配（短摘要 + import `AGENTS.md`）
- `../INSTALL_FOR_AGENTS.md` — 在用户机器上安装 agentmemory 的 agent runbook
- `../README.md` — 用户向安装与 API
