# 已知问题

> 当前开放的问题, 更新于 2026-07-10。每条包括: 严重度,
> 根因, 怎么修。

## 开放

### 1. per-obs LLM 调用是吞吐瓶颈

- **症状**: `mem::compress` 实际 ~4 obs/min (峰值 ~12 obs/min)。
  对 2460-obs backfill 那是 ~10 小时单线程排空。
- **根因**: `mem::compress` handler 对每条观测发一个
  `POST /v1/chat/completions`。每次 ~5s 在 V100 32GB 上。
  concurrency=1 (故意设的, 避免 24GB qwen3.6:35b 抢 GPU) 限了
  并行。
- **严重度**: 中。corpus 已排空, 不阻塞线上使用, 但重新压
  缩或换 corpus 会触发。
- **修法** (没实现): 批量模式。内存里 buffer N 条 obs, 一
  次 chat completion 把 N 条都放进 user prompt, 从结果里解析
  N 个 `<observation>` 响应。取舍: 更大 prompt → 更多 VRAM,
  但一次冷加载摊到 N 条 obs 上。
- **状态**: 已知, 没有 in-flight 工作。

### 2. daemon 运行时 24GB VRAM 永远占着

- **症状**: `qwen3.6:35b` (22GB) 在 daemon 活着且队列非空
  时一直占着 VRAM。
- **根因**: Ollama 5 分钟无请求后卸载模型。只要 `mem::compress`
  在以任何速率从队列消费, 模型就不会 idle, 不会卸载。在我
  们设置下队列很少空, 所以卸载很少发生。
- **严重度**: 如果 GPU 跟其他工作共享则高; 专用则低。
- **修法** (没实现): 批量模式 (item #1) 会自然产生 idle 时
  段让 Ollama 卸载。或者显式设个短 `OLLAMA_KEEP_ALIVE=2m`
  (短, 不是 24h) —— 短于队列空周期也短于任何合理的 agent 暂
  停。commit `0b43c4c` 移除了 24h 变体; 取舍讨论在
  `docs/IMPROVEMENTS.md`。
- **状态**: 已知, 需要批量模式 fix 或"可接受 VRAM 保留" 的
  策略决定。

### 3. 检索质量 (R@10 = 29.6%) 低于典型目标

- **症状**: 16-query benchmark 报告 R@10=29.6%, MRR=0.224。
  最好查询 (VASP binary cleanup, find large files) 100%, 但
  平均被稀疏 ground truth 的查询拖低。
- **根因**: 可能是混合原因: (a) 通用 embedding 模型 (nomic-embed
  768d, 无微调), (b) corpus 是 commit `8756a5b` 之前的旧
  prompt 处理的, (c) ground truth 稀疏 — 只有 16 个 hand-labeled
  查询。
- **严重度**: 中。搜索在分数高的具体查询上可用; 长尾质量未
  知。
- **修法** (没实现): 三个改动值得试, 按可能效果排序:
  1. 用 Phase 3 prompt 通过 `scripts/upgrade-backfill-compression.py`
     重新压缩 2460 条 obs (~10h 后台)
  2. 扩展 ground truth 到 30-50 个查询覆盖更多 session 类型
  3. 试更大的 embedding 模型 (`bge-large-en-v1.5` 1024d) — reindex
     是单独操作
- **状态**: 已知, 评估进行中。

### 4. `/agentmemory/sessions` 在 100+ session 时慢

- **症状**: GET `/agentmemory/sessions?limit=5` 在 corpus 有
  100+ session 时可能要 >10s。Handler 读完整 session 列表,
  然后逐个 fetch per-session 摘要, 顺序执行。
- **根因**: `src/triggers/api.ts` 做了
  `Promise.all(sessions.map(s => kv.get(summaries, s.id)))`。
  list-and-fetch 在 ≤50 session 时还行, 超过线性退化。
- **严重度**: 低。诊断工具 (`scripts/health.sh`,
  `scripts/trace-obs.sh`) 绕开这个端点。
- **修法** (没实现): 分页响应, 或在内存里缓存摘要并增量
  刷新。
- **状态**: 已知, 低优先级。

### 5. daemon 重启可能留 orphan workers

- **症状**: daemon 崩溃 + 重启后, `/health` 显示 `workers: 2`
  而不是 `workers: 1`。engine 上老的 worker 注册 stale 但
  engine 没察觉。
- **根因**: iii-engine v0.11.2 不会自动 expire stale workers。
- **严重度**: 低。新 worker 处理所有流量; 老的只是注册的
  no-op。
- **修法** (workaround): 重启前 kill 任何 `node.*agentmemory`
  进程。更好的修法: 升级 iii-engine 到会 expire stale
  workers 的版本。
- **状态**: 已知, workaround 有文档。

### 6. DLQ 深度会在坏 batch 进入时涨

- **症状**: `dlq_depth` 7/8 是 0; 7/9 又涨到 8。
- **根因**: DLQ 重试 1 次, backoff 2s。一波坏输入 (如
  LLM 持续解析不了的格式错 tool output) 会以 2s/obs 速率进
  DLQ。DLQ 不会自动排空。
- **严重度**: 低。DLQ 增长由坏输入的速率限制。用
  `scripts/drain-dlq.py` 清空。
- **修法** (没实现): 把 `drain-dlq.py` 安排成 cron 让 DLQ
  保持空。
- **状态**: 已知, 手动 drain 可用。

### 7. Query expansion 加 +40% 延迟但精度中性

- **症状**: 接上 `mem::expand-query` 后, benchmark 延迟从
  ~570ms 跳到 ~1150ms, 但 R@10 和 MRR 没提升。
- **根因**: 对 VASP-specific benchmark 集, LLM 生成的改写
  没有给 BM25+vector 排名已经抓到的信号再加料。改写在为零
  收益时还在付延迟成本。
- **严重度**: 对当前 corpus 低。改写可能对更多样或模糊的查
  询有用。
- **修法** (没实现): 加个 env flag
  `AGENTMEMORY_QUERY_EXPANSION=false` 在延迟敏感路径禁用。
  或者: 只对短查询触发 expansion (长查询一般已经组织好)。
- **状态**: 已知, env flag 已提议。

## 已解决

- **Rerank 输入形状错了** (单串而不是 query+doc pair)。修在
  commit `04e701c` — `reranker.ts` 现在用 `{text, text_pair}` 跨
  编码器 API。
- **Orphan obs 3 次重试 30s 浪费后进 DLQ**。修在 commit
  `e769842` — `compress.ts` 现在 obs 在 KV 缺失时 silently ack。
- **24h `OLLAMA_KEEP_ALIVE` 是 workaround**。commit `0b43c4c`
  移除; 队列就是设计来 absorb 30-60s 冷加载的。
- **OMP serverOk 是 sticky latch**。修在 commit `a8a5a99`
  —— 替换为 `ensureServerOk()` TTL 缓存探测。
- **DLQ 分页坏了**。修在 commit `735b4f0` — `drain-dlq.py` 从
  offset 0 重分页 + dedup。

## 另见

- `docs/architecture.md` — 怎么连起来
- `docs/IMPROVEMENTS.md` — 完整改动历史
- GitHub issues — 具体 bug 报告带复现步骤
