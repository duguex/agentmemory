# 已知问题

> 当前开放的问题, 更新于 2026-07-13。每条包括: 严重度,
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

### 3. 观测级检索质量未标定 (session 级已可用)

- **症状 / 现状 (2026-07-12)**: 刷新 GT 后 **session R@10=93.8%**, session MRR=0.750
  (16 queries, hybrid: `npx tsx benchmark/backfill-quality-eval.ts`)。obs 级标签仍弱。
- **Embedding 对照 (2026-07-13, vector-only)**: 在同语料 1162 docs / 16 查询上:
  - `nomic-embed-text` 768d: R@10=**0.979**, MRR=**0.938**（最好）
  - `nomic-embed-text-v2-moe` 768d: R@5 略升，R@10/MRR 下降 → **不换**
  - `qwen3-embedding` 4096d: 更慢（~25×）且 R@5/MRR 明显更差 → **否**
  - 详见 `docs/IMPROVEMENTS.md`「Phase Embedding 对照」与 `.superpowers/sdd/embed-compare-2026-07-13.json`
- **根因（obs 级）**: (a) 评测标签与 corpus 漂移; (b) 缺/弱 obs 级金标; (c) **不是**「换个更大 embedding 就自动好」。
- **严重度**: 中对「细粒度引用」; 低对「上下文注入」 (session 级已够用)。
- **修法**:
  1. 为每查询补 2–5 个 full obsId 到 `relevantObservations`（若还要 obs 级指标）
  2. ~~试更大本地 embedding~~ **已试；本机语料无收益，保持 nomic-embed-text**
  3. 可选: BM25/graph 权重、query expansion、开 `RERANK_ENABLED`（共享 GPU 慎用）
- **状态**: baseline 已刷新; embedding 选型 **已冻结为 nomic-embed-text 768d**。


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

### 5. daemon 重启可能留 orphan workers — **supervised 下已缓解**

- **症状（旧）**: daemon 崩溃 + 重启后, `/health` 显示 `workers: 2`。
- **根因**: iii-engine v0.11.2 不 expire stale workers；旧路径 CLI import + iii-exec 双注册。
- **现状 (2026-07-13)**: 本机 supervised 使用 `iii-config.supervised.yaml`（**无 iii-exec**）+ `scripts/am-daemon.sh`，正常 **`workers=1`**。
- **仍可能**: 混用旧 `nohup`/手动 iii 与 am-daemon 时 residual 注册。
- **修法**: 只用 `am-daemon.sh stop|start`；需要时 `ensure`。
- **状态**: **本机默认路径已缓解**；非 supervised 安装仍可能双 worker。

### 6. DLQ 深度会在失败/重启时涨

- **症状**: `mem::compress` 的 `dlq_depth` 在杀 iii、半死重启、或坏 payload 后上升；旧 `am-daemon health` 仍绿。
- **根因**: iii-queue 在 `max_retries` 耗尽后进 DLQ；compress 曾 `max_retries: 1`。错误常见 `function call failed`。
- **严重度**: 中（可见性）。
- **修法 (2026-07-13, #69/#71)**:
  - `am-daemon.sh health` / `status`：**dlq>0 → exit 1**；`ensure` 不因 DLQ 重启。
  - compress `max_retries: 1 → 3`（`iii-config*.yaml`）。
  - 诊断: `queue-diag.sh`；重放优先 redrive；`drain-dlq.py` 仅归因后使用。
- **状态**: 可见性已修；历史 DLQ 需人工 redrive/drain。

### 6b. compress depth 钉在 ~90：durable queue 不投递/不 reclaim — **启动自愈默认开**

- **症状**: `mem::compress` depth 长期平台（如 ~90–100），`dlq=0`，偶有 success；从几百掉到平台后不空。
- **根因（已验证）**:
  1. **不是** skip 逻辑不 ACK：对已 `llm` 的 obs 重新入队，consumer 数秒内 depth→0（`already_llm` skip 正常出队）。
  2. **是** iii 0.11.2 `file_based` 队列里消息长期停在 durable `active`、**attempts=0 从未被消费**（崩溃/半死/粘连 claim 无 visibility reclaim）。重启也不一定 reclaim。
  3. 其中大量条目已是 `already_llm` / orphan，占 depth，看起来像 fail-requeue 或 ingress≈egress。
- **严重度**: 中。
- **修法 (2026-07-14, #72)**:
  - **默认** `am-daemon start`：`--check` 失败或 trailing garbage → 自动 **safe reclaim**（不是清空队列）。
    - 只丢 **already_llm** 的 *queue job*（obs 已在 state 里压缩完）。
    - **needs_work / orphan 保留** job 文件，清 garbage、reset attempts、重建 active list 以便重新投递。
    - **corrupt** 进 `.quarantine/`（完整 backup 在 `data/backups/`），不静默扔掉。
    - 关自愈：`AGENTMEMORY_QUEUE_REPAIR_ON_START=0`。
  - 诊断：`queue-reconcile.py --check`、`queue-diag.sh`、`health` 对 zombie 比例 **exit 1**。
  - 引擎层真正 reclaim 需 iii 升级；本仓库在 pin 0.11.2 下做 **投递层自愈**。

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

### 8. OMP 注入「开了也不进 prompt」

- **症状**: `~/.agentmemory/.env` 里 `AGENTMEMORY_INJECT_CONTEXT=true`，但 OMP 会话无回忆；或扩展静默不搜。
- **根因**:
  1. 扩展读的是 **omp 进程** 的 `process.env`，不自动加载 daemon 的 `.env`；
  2. 无 `AGENTMEMORY_SECRET` 时 `/health` 401 → `ensureServerOk` 失败 → 整段注入跳过；
  3. stdout 看不到 `## Recalled from memory`（在 systemPrompt）被误判为未注入。
- **严重度**: 中（功能形同关闭）。
- **修法**: 启动 omp 前 export `AGENTMEMORY_URL` / `SECRET` / `INJECT_CONTEXT=true`；验收用 `AGENTMEMORY_INJECT_DEBUG=true` 看 `inject ok lines=N`。
- **状态**: 2026-07-13 CLI 已验证注入路径；文档见 `architecture.md` OMP 节与 usefulness-trial 附录 C。


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
