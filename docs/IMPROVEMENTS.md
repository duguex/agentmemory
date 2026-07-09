# 改进追踪

> agentmemory backfill 观测和检索质量的改动历史。更新于 2026-07-10。

## 系统现在什么样

| 指标 | 值 |
|---|---|
| 观测 | 2460 条 backfill (100% LLM 压缩) |
| Session | 94 个 backfill + 活跃 |
| 检索质量 (R@10 / MRR) | 29.6% / 0.224 (16-query 标注集) |
| Daemon | 健康, 单进程, 熔断关闭 |
| DLQ | 0 (从 5538 排空, 2026-07-08) |
| 开放 issue | 21 (15 原有 + 6 本次新增) |

看一行状态, 跑 `bash scripts/status.sh`。
看全貌, 见 `docs/architecture.md` 和 `docs/known-issues.md`。

## Phase 1 — DLQ 清理

**目标**: 停止 DLQ 增长, 清空 7/4-7/7 schema-lock 灾难留下的
5538 条 backlog。

| 改动 | Commit | 备注 |
|---|---|---|
| `compress.ts:90` 在 KV entry 缺失时返回 `{success: true, skipped: true, reason: "orphan_observation"}` 而不是 throw | `e769842` | orphan 不再走 3-重试 → DLQ 路径 |
| `iii-config.yaml`: `max_retries: 3 → 1`, `backoff_ms: 5000 → 2000` | `e769842` | 每次失败少浪费时间 |
| `scripts/drain-dlq.py`: 分页 + snapshot + discard 幂等 | `e769842` | 在 `735b4f0` 还有个 fix (见 Phase 1.5) |

DLQ 5538 → 0, ~4 分钟跑完 (运维层面验证, 用
`iii trigger engine::queue::topic_stats`)。

**Phase 1.5** (计划外): `drain-dlq.py` 最初用 `offset += page_size`
分页, 但 iii-queue 的 DLQ 是 sorted 的, discard 之后消息从
list 里删除, 所以 `offset=N` 在前 N 个被 discard 后返回空。
Fix 在 `735b4f0`: 总是从 offset 0 重分页 + dedup。

## Phase 2 — 检索质量

**目标**: 停止 41.7% R@10 假数据, 给 eval 真实信号, 修 rerank,
接 query expansion。

| 改动 | Commit | 备注 |
|---|---|---|
| `reranker.ts` 用跨编码器 pair API (`{text, text_pair}`) 而不是拼成单串。parallel 评分 + 250ms/pair timeout。70/30 跟原 `combinedScore` blend 防止灾难性重排 | `04e701c` | 之前评分"这个串跟自己相关吗" |
| `index.ts:381` 显式传 `rerankEnabled` 给 `HybridSearch` (之前依赖 env 默认 = false) | `04e701c` | rerank 现在默认真跑 |
| `benchmark/backfill-quality-eval.ts` 重写: 16 个 hand-labeled 查询, 5 类, observation-level + session-level 指标, NDCG, HitRate, 完整 UUID 匹配 | `04e701c` | 旧 eval 有 3 个 bug 让数字无意义: 空相关 = 1.0, 模糊 UUID, 只 session-level |
| `smart-search.ts` 触发 `mem::expand-query` (200ms 预算) 走 `HybridSearch.searchWithExpansion` | `d9a5b52` | query expansion 可达。函数注册了但没用过 |
| `benchmark/tune-weights.sh`: BM25/vector 权重 grid search | `52f231a` | 验证默认 `0.4 / 0.6 / 0.3` 对 VASP benchmark 是准最优 |

**结果**: Session R@10 = 29.6%, MRR = 0.224。两个查询
100% (VASP binary cleanup, find large files)。`benchmark/QUALITY.md`
的 41.7% / 0.200 是被空相关 bug 吹起来的, 现在 stale (issue #62)。

**注意**: Query expansion 在 VASP benchmark 上 +40% 延迟但
精度中性, 见 known-issues #7。

## Phase 3 — Corpus 质量

**目标**: 改善 LLM 压缩观测的内容。

| 改动 | Commit | 备注 |
|---|---|---|
| `prompts/compression.ts`: 严格 importance rubric (1-3 日常, 4-6 正常, 7-9 决策, 10 破坏性), 2-5 可搜 concepts, dedup 规则, "为可检索而优化"开头 | `8756a5b` | |
| `prompts/summary.ts`: 加 `<tags>` 字段, lead-with-decision narrative 规则, REDUCE 里的 override 语义 | `8756a5b` | tags 在现有 XML schema 里 — 不需要改 parser |
| `providers/openai.ts`: `temperature: 0` 默认, 429/5xx/timeout 重试 2 次指数退避 | `8756a5b` | corpus 跨重新压缩稳定 |

**实际验证** (POST 一条 `ls -la` obs 到新 daemon):

| 字段 | 旧 prompt | 新 prompt |
|---|---|---|
| `title` | "Synthetic observation" 或模糊 | "ls -la /home/duguex/.agentmemory/data/" |
| `importance` | 4-6 (rubric 被忽略) | **2** (正确: 日常 ls) |
| `concepts` | 0-1 通用 | 3 个具体词 |
| `narrative` | "Command completed" | 自然语言描述发生了什么 |

**重要**: 2460 条已存在的 backfill 观测是**旧**prompt 处理
的。用 Phase 3 prompt 重新压缩它们是检索质量最高的
杠杆。估计: ~10 小时后台, 用
`scripts/upgrade-backfill-compression.py`。

## Phase 4 — 之前代码 review 的待修 issue

15 个已有 issue, 全部在 `feat/omp-adaptation` 的 commits 里修
了:

| Issue | 内容 | Commit |
|---|---|---|
| #56 | OMP session_shutdown 的 `setTimeout` 缺 `.unref()` | `a8a5a99` |
| #53 | `JSON.stringify(event.result)` 丢 Error 细节 | `28c13cb` |
| #27, #55 | OMP `serverOk` 是 sticky latch | `a8a5a99` |
| #21 | OMP `currentProject` 在 `cd` 后不刷新 | `00b0d89` |
| #22, #23 | OMP `agent_start`/`agent_end` 生命周期不对称 | `00b0d89` |
| #25 | OMP `systemPrompt=""` 产生多余换行 | `a8a5a99` |
| #54 | OMP URL 前缀用 hostname 子串匹配 | `00b0d89` |
| #28 | OMP `apiGet` 给无 body GET 发 `Content-Type` | `00b0d89` |
| #52 | OMP `Promise.withResolvers` 要求 Node 22+ | `00b0d89` |
| #33 | `getAutoForgetIntervalMs`/`getEvictIntervalMs` 重复 `safeParseInt` | `2f164f8` |
| #32 | `AUTO_FORGET_INTERVAL_MS` 重命名无迁移路径 | `2f164f8` + `7d54c91` |
| #29 | OMP `maybeWarnPlaintextBearer` dead function body | `a8a5a99` |
| #57 | `auto-compress.test.ts` 环境隔离 bug | `e181610` |

**22 个 issue 全部关闭** (15 原有 + 7 本次新增)。GitHub issue
列表现在空。

## Phase 5 — 队列 hold 行为

**目标**: 区分 "LLM 临时不可用" (hold + 重试) 和 "请求有
问题" (重试 + DLQ)。

| 改动 | Commit | 备注 |
|---|---|---|
| `OpenAIProvider.isLlmUnavailable(err)` 静态方法检测 Ollama "model not found" / ECONNREFUSED / "model not loaded" | `426d1fa` | 模式匹配错误消息 |
| `compress.ts` catch 块把 `LlmUnavailable` 路由到 `{success: true, skipped: true, reason: "llm_unavailable"}` | `426d1fa` | engine ack, 不进 DLQ。下次入队时重试 |

5 分钟 Ollama 卸载不再被 24h `OLLAMA_KEEP_ALIVE` env 锁住
(commit `0b43c4c`)。队列空时, 模型卸载, 下次请求触发 30-60s
冷加载, 队列 absorb 这个延迟。

## Phase 6 — 文档和工具

| 内容 | Commit |
|---|---|
| `docs/architecture.md` — 单页架构总览 | `8ed35b0` + `acd77cd` + `5d195b6` + `5a9822a` |
| `docs/IMPROVEMENTS.md` — 本文件 (重写得更清晰) | (本次 commit) |
| `docs/final_purpose.md` — 7/2 设计目标状态 | `b07b0f4` |
| `docs/known-issues.md` — 当前开放问题 + 根因 / 修法 / 状态 | `bed9d20` |
| `scripts/status.sh` — 一次性系统状态 | `6333b2e` |
| `scripts/health.sh` — 快速状态, 绕过 `/sessions` | `a512c2f` |
| `scripts/trace-obs.sh` — 跟踪一条观测的全流程 | `a512c2f` |
| `scripts/drain-dlq.py` — DLQ snapshot + discard (Phase 1) | `e769842` + `735b4f0` |

## Branch 状态

| Branch | 状态 |
|---|---|
| `feat/omp-adaptation` (at origin) | 比 `main` 领先 16 个 commit, 全部 push |

## 耗时

- Phase 1 + 1.5: 30 分钟代码 + 5 分钟排空
- Phase 2: ~2 小时 (rerank 修 + GT 重写 + expansion 接 + grid search)
- Phase 3: ~1 小时 (prompts + provider)
- Phase 4: ~3 小时 (13 OMP/config/test 修)
- Phase 5: ~30 分钟 (queue hold + keep_alive 移除)
- Phase 6: ~2 小时 (重写 + 诊断工具)
- Issue 管理: 1 小时
- **总计: ~10 小时, 4 天**

## 怎么收尾剩下的 gap

从 `docs/known-issues.md`, 按可能效果排序:

1. **用 Phase 3 prompt 重新压缩 2460 条 obs** (~10h 后台)
2. **扩展 ground truth 到 30-50 个查询**, 让 eval 信号稳定
3. **试更大的 embedding 模型** (如 `bge-large-en-v1.5` 1024d) — 需要 reindex

第一项纯后台; 后两项需要人。都不是线上使用的 blocker。

## 怎么跑

```bash
# 状态 (出问题先跑这个)
bash scripts/status.sh          # daemon, queue, observations, recent log
bash scripts/health.sh          # 快, 绕过 /sessions 端点

# 跟踪一条观测
bash scripts/trace-obs.sh <sid> <oid>

# 跑检索质量 benchmark
cd /home/duguex/memory/agentmemory
npx tsx benchmark/backfill-quality-eval.ts

# 排空 DLQ
python3 scripts/drain-dlq.py

# 手动触发一条 obs 通过 compress 队列
curl -X POST http://localhost:3111/agentmemory/compress \
  -H "Authorization: Bearer omp-memory-local" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<sid>","observationId":"<oid>"}'

# 看队列
/home/duguex/.agentmemory/bin/iii trigger --function-id engine::queue::topic_stats --payload '{"topic":"mem::compress"}'
/home/duguex/.agentmemory/bin/iii trigger --function-id engine::queue::dlq_messages --payload '{"topic":"mem::compress","limit":10}'

# 重启 daemon
pkill -9 -f "node.*agentmemory" 2>/dev/null
rm -f ~/.agentmemory/worker.pid ~/.agentmemory/iii.pid
nohup agentmemory > /tmp/daemon.log 2>&1 &
```
