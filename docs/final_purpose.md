# 最终目标

> 7/2 设计目标的当前状态, 更新于 2026-07-12。

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
| 1 | 高质量可检索记忆 | **基本达成; session 级检索可用, obs 级未标** | 语料仍在增长 (live + backfill)。**2026-07-12 刷新 GT 后**: session R@10=**93.8%**, session MRR=**0.750**, avg latency ~592ms (16 labeled queries, `benchmark/backfill-quality-eval.ts`)。旧数字 R@10=29.6%/MRR=0.224 的 GT session 已几乎不存在 (11 里仅 1 仍在), 不可再当 baseline。obs 级 R@10 仍为 0% — 当前 GT **只标 session 不标 observation**。 |
| 2 | 适配不同 agent | **部分达成** | OMP 集成完全接好。Claude/Codex/OpenCode hooks 存在; 本 fork 可靠性 P0 (#65–#67) 已修并部署。 |
| T1 | 统一 backfill + 实时流水线 | **达成** | `scripts/backfill-sessions.py` 复用 `/observe` 端点。LLM 调用是同一个 `mem::compress` handler。见 `docs/architecture.md` 的两条路径图。 |
| T2 | 用队列处理高 LLM 流量 | **达成, 有已知限制** | `mem::compress` 队列 absorb 延迟、重试、还有 LLM 不可用。**per-obs LLM 调用**是吞吐瓶颈 (优先级最低, 暂不优化)。 |

## 影响这些目标的已知限制

这些不是 blocker, 但在声称"目标达成"前值得知道:

- **Session 级检索已可用 (R@10≈94%), 但观测级 GT 仍可加强**。下一杠杆: 为关键查询补 `relevantObservations` 细粒度标签（若需要 obs 级指标）。
- **Embedding 选型 (2026-07-13)**: 本机对照 `nomic-embed-text` vs `nomic-embed-text-v2-moe` vs `qwen3-embedding`（vector-only）。**保持 nomic-embed-text 768d**；后两者无整体提升（qwen3 更慢更差）。见 `docs/IMPROVEMENTS.md` Embedding 对照。
- **没有批量 LLM 调用**。每条 obs 独立 LLM 调用; 已用 `OPENAI_REASONING_EFFORT=none` + gate concurrency=2 改善吞吐; 积压仍可能。
- **daemon 运行时大模型 VRAM 常驻**。Ollama 仅在队列空闲后卸载; 共享 GPU 场景敏感。
- **评测 GT 会过期**。corpus 漂移会让旧 R@10 失真; 大清洗后应重标。

## 怎么收尾 gap

若要在 **观测级** 质量上继续提升 (session 级已够用上下文注入):

1. **补 obs 级 GT** (每查询 2–5 个 `relevantObservations` full id)。
2. ~~试更大的本地 embedding + reindex~~ **已试，本机无收益；勿为换模而 reindex**。
3. 可选: Phase 3 prompt 重压仍为 synthetic/旧 narrative 的子集。

如果只关心 *corpus 存在* + session 级召回够用, 系统已经可用。跑 `bash scripts/status.sh` 确认 daemon 健康; 评测: `npx tsx benchmark/backfill-quality-eval.ts`。

## 另见

- `docs/architecture.md` — 当前架构
- `docs/IMPROVEMENTS.md` — 改动历史
- `docs/known-issues.md` — 当前开放问题
- `benchmark/backfill-quality-eval.ts` — 跑检索 eval
