# docs/ 入口

> agentmemory 项目文档的导航页。

## 4 个核心文档

| 文档 | 答什么问题 | 长度 | 更新频率 |
|---|---|---|---|
| [`architecture.md`](./architecture.md) | 系统由什么组成?数据怎么流? | 408 行 | 架构变化时 |
| [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) | 过去改了什么?为什么改? | 191 行 | 每次 commit 后 |
| [`known-issues.md`](./known-issues.md) | 现在还有什么问题?怎么修? | 130 行 | 问题变化时 |
| [`final_purpose.md`](./final_purpose.md) | 最初想做什么?做到了吗? | 62 行 | 阶段结束时 |

## 推荐阅读顺序

按用途:

- **新人加入项目** → 顺序读全部 4 个 (~30 分钟)
- **想理解系统怎么工作** → architecture.md
- **想看最近的改动** → IMPROVEMENTS.md (按 phase 倒序读最新)
- **想看还有什么是 broken** → known-issues.md
- **想评估系统是否达到目标** → final_purpose.md

按紧急度:

- **出问题先看** → `bash ../scripts/status.sh`, 再看 architecture.md 的 "Known limitations" 段
- **想改代码** → IMPROVEMENTS.md 找相关 phase, 再看 known-issues.md 找未解决的相关问题

## 其他文档

- `recipes/` — 实用配方(对比不同 agent 的检索质量等)
- `benchmarks/` — 历史 benchmark 报告
- `issues/` — 本地 issue 记录(代码 review 时的 P0-P2 发现)
- `reviews/` — 之前的代码 review 报告

这些是历史/参考材料, 跟 4 个核心文档不重复。

## 文档维护规则

- 4 个核心文档**互相引用**, 不要在多个文档里说同一件事
- 改代码 → 更新 IMPROVEMENTS.md
- 发现新问题 → 更新 known-issues.md (open 部分)
- 改架构 → 更新 architecture.md
- 目标变化 → 更新 final_purpose.md

## 另见

- `../CLAUDE.md` — 项目根快速参考
- `../AGENTS.md` — 编码约定
