# 最终目标

> 7/2 设计目标的当前状态, 更新于 2026-07-10。

## 原始目标 (2026-07-02 定)

1. **把 OMP/Oh-My-Pi 聊天历史处理成高质量记忆**, 可检索,
   可用于相关内容的上下文注入。
2. **适配不同编程 agent。**

## 原始技术路线

1. **统一**聊天历史和活跃 session 的处理流水线, 让 backfill
   尽可能复用活跃 session 路径。
2. **用队列**处理大量 LLM 请求, 接受高 LLM 用量, 追求记忆
   质量。

## 当前状态

| # | 目标 | 状态 | 证据 |
|---|---|---|---|
| 1 | 高质量可检索记忆 | **基本达成, 检索质量一般** | 2460 条 backfill obs, 100% LLM 压缩。Eval R@10=29.6%, MRR=0.224 (16 个 hand-labeled 查询)。最好查询 100% (VASP binary cleanup, find large files)。 |
| 2 | 适配不同 agent | **部分达成** | OMP 集成完全接好。Claude/Codex/OpenCode hooks 存在但测试期间没跑过。 |
| T1 | 统一 backfill + 实时流水线 | **达成** | `scripts/backfill-sessions.py` 复用 `/observe` 端点。LLM 调用是同一个 `mem::compress` handler。见 `docs/architecture.md` 的两条路径图。 |
| T2 | 用队列处理高 LLM 流量 | **达成, 有已知限制** | `mem::compress` 队列 absorb 延迟、重试、还有 LLM 不可用 (commit `426d1fa`)。**per-obs LLM 调用**是吞吐瓶颈 —— 见下面"已知限制"。 |

## 影响这些目标的已知限制

这些不是 blocker, 但在声称"目标达成"前值得知道:

- **检索质量 (R@10=29.6%) 低于典型生产目标 (≥50%)**。根因:
  GT 稀疏 (16 查询, 5 类), embedding 模型通用 (nomic-embed
  768d), ~2460 obs 用旧 prompt 处理的。用 Phase 3 prompt
  (commit `8756a5b`) 重新压缩是剩余工作中最高杠杆的一项。
- **没有批量 LLM 调用**。每条 obs 是独立的 LLM 调用, 这对
  正确性是对的但对吞吐是错的。1 obs = 1 调用, ~5s/obs,
  队列峰值能排 ~12 obs/min。批量模式让一次冷加载处理 N 条 obs
  在一次推理里。
- **daemon 运行时 24GB VRAM 永远占着**。Ollama 5 分钟卸载
  只在队列空 5+ 分钟时触发。这是 commit `0b43c4c` 的设计选择,
  但如果 GPU 跟其他工作共享就值得知道。

## 怎么收尾 gap

如果想要 R@10 ≥ 50% 但不想继续迭代:

1. **用 Phase 3 prompt 重新压缩 2460 条 obs** (~10 小时后
   台)。跑 `scripts/upgrade-backfill-compression.py`。
2. **扩展 GT 到 30-50 个查询**, 让 eval 信号稳定。16 太
   少。
3. **试更大的 embedding 模型** (如 `bge-large-en-v1.5` 1024d)。
   Reindex 是单独 commit。

如果只关心 *corpus 存在* + 检索质量够用于上下文注入, 系统已
经可用。跑 `bash scripts/status.sh` 确认 daemon 健康。

## 另见

- `docs/architecture.md` — 当前架构
- `docs/IMPROVEMENTS.md` — 改动历史
- `docs/known-issues.md` — 当前开放问题
- `benchmark/backfill-quality-eval.ts` — 跑检索 eval
