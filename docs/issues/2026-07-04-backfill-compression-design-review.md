# Code Review — backfill compression fix design (2026-07-04)

**审查对象**：`docs/superpowers/specs/2026-07-04-backfill-compression-fix-design.md`

**审查范围**：设计文档本身 + 验证文件引用（src/functions/observe.ts:287-296、src/triggers/events.ts:64-74、src/triggers/api.ts:451/1613、src/functions/compress.ts:144-154、src/config.ts:399-400、iii-config.yaml）

**审查方法**：7 个独立角度（line-by-line / removed-behavior / cross-file / reuse / simplification / efficiency / altitude）× 各 4-6 候选 → 去重 → 1-vote 验证（recall-biased）→ 10 条 CONFIRMED/PLAUSIBLE。

**结论**：10 条 candidate 全部 CONFIRMED。其中 **3 条为 spec 独有的设计错误**（改 spec 即可修），**6 条为 spec 揭示的已有架构弱点**（需要同时改 spec 和底层代码/配置），**1 条为 spec 的战略取舍问题**（应在 spec 内重新论证）。按严重度排序。

---

## 严重度图例

- 🔴 **P0** — 生产环境功能静默失效 / 验收条件结构性不可达
- 🟠 **P1** — 数据正确性 / 一致性损坏 / catch-up 期间成本失控
- 🟡 **P2** — 运维效率 / 资源消耗 / 设计深度不足

---

## 发现归属说明

为便于 issue 跟踪与责任划分，每条发现标注**归属**：

- **[SPEC]**：spec 独有的设计错误，改 spec 即可修
- **[CODE]**：spec 揭示的已有代码 / 配置问题，需要同时改底层
- **[SCOPE]**：spec 的战略取舍，需要重新论证

---

## 🔴 P0-1 · AUTO_COMPRESS 默认 false，新 Enqueue 路径在默认部署下是死代码 [CODE]

**文件**：`src/functions/observe.ts:287`（spec 引用 line 295）
**关联**：`src/config.ts:399-400` — `isAutoCompressEnabled()` 仅在 `AGENTMEMORY_AUTO_COMPRESS === "true"` 时返回 true，默认 false

### 问题

Void→Enqueue 改动被 `if (isAutoCompressEnabled())` 门控。但 `AGENTMEMORY_AUTO_COMPRESS` 默认 false（config.ts:400），设计从未将此设为前置条件。

```ts
// observe.ts:287-296（当前）
if (isAutoCompressEnabled()) {
  await sdk.trigger({
    function_id: "mem::compress",
    payload: { observationId: obsId, sessionId: payload.sessionId, raw },
    action: TriggerAction.Void(),  // ← spec 要改成 Enqueue
  });
} else {
  const synthetic = buildSyntheticCompression(raw);  // ← 默认走这里，无 LLM
  await kv.set(KV.observations(payload.sessionId), obsId, synthetic);
  // ...
}
```

设计 line 283-286 的注释解释了默认关闭的**产品决策**：节省 Claude token 配额。但 spec 改动（Void→Enqueue）只在 `isAutoCompressEnabled()` 分支内生效，默认部署下整个新路径是 dead code。

### 影响

- AC2（POST /observe → observation 入队）只在 `AUTO_COMPRESS=true` 部署下成立
- AC7（小项目 backfill 重跑 → 结果与 live session 无差异）**结构性失败**：即使 100% backfill observation 通过 REST 端点获得 title，live session 仍走 synthetic 分支（无 LLM、无 facts/concepts/narrative），两条路径永远不收敛
- Spec 验证 AC 时不会发现此问题，因为测试环境通常显式设 `AUTO_COMPRESS=true`

### 修复

三选一：

1. **前置条件声明**（spec 侧）：在 P1 实施前明确"必须先设 `AGENTMEMORY_AUTO_COMPRESS=true`，并在 boot log 中断言此状态"
2. **改动位置移到门控外**（代码侧）：把 Enqueue 调用搬到 `isAutoCompressEnabled()` 之外，由队列 worker 决定是否实际调用 LLM（仍可保留 token 节省，但保证活路径入队）
3. **改默认值为 true**（配置侧）：不符合现有产品决策，最差选项

---

## 🔴 P0-2 · api::compress 把 synthetic CompressedObservation 当 RawObservation 传入 [CODE]

**文件**：spec 变更 3 代码块 line 156 / `src/triggers/api.ts`（新端点待注册）

### 问题

api::compress 端点通过 `kv.get<RawObservation>(...)` 读取，但 `KV.observations(sessionId)` 中存储的可能是：

- **真 RawObservation**（AUTO_COMPRESS=true 路径，未压缩前）
- **synthetic CompressedObservation**（AUTO_COMPRESS=false 路径，有 title 但无 toolInput/toolOutput/userPrompt — observe.ts:297-330）
- **LLM-generated CompressedObservation**（mem::compress 完成后，有 title+facts+narrative）

`if (raw.title) return skipped` 仅对 LLM-generated 起作用；synthetic 类型的 title 是 `buildSyntheticCompression` 设置的（如 obs 内容首行截断），而真 RawObservation 在写入时**没有** `title` 字段（只有 hookType/toolName/toolOutput）。

把它作为 `raw` 传给 mem::compress → `buildCompressionPrompt` 读取 `raw.toolInput/toolOutput/userPrompt`（compress.ts:111-119）— 对 synthetic 全部 undefined，LLM 在空 prompt 上要么返回无效 XML，要么幻觉。

### 影响

- 默认部署下绝大多数 observation 是 synthetic 类型，refine catch-up 调用会高频触发此 bug
- LLM 在空 prompt 上可能返回合规 XML（带幻觉 title/facts），覆盖真实合成数据，污染搜索/语义图
- spec 没有任何类型断言或 schema 校验拦截

### 修复

在端点中加类型守卫：

```ts
// 拒绝非 RawObservation
if (!("hookType" in raw) || !("toolName" in raw)) {
  return { status_code: 422, body: { error: "synthetic observation not eligible for LLM compress; raw fields missing" } };
}
```

或更彻底：让 mem::compress 按 `observationId` 重读（与 finding P1-3 一并修复），端点只传 ID。

---

## 🔴 P0-3 · `/agentmemory/graph-build` 路径应为 `/agentmemory/graph/build` [SPEC]

**文件**：spec 变更 4 phase 4 line 201；实际注册见 `src/triggers/api.ts:1613`

### 问题

Spec 文本："graph-build（api.ts:1555）已存在，不需要新代码" — api.ts:1555 是**函数注册**，但 HTTP 路径在 line 1613：

```ts
// api.ts:1610-1614
sdk.registerTrigger({
  type: "http",
  function_id: "api::graph-build",
  config: { api_path: "/agentmemory/graph/build", http_method: "POST" },  // ← 斜杠
});
```

spec 在脚本流程里写的 `POST /agentmemory/graph-build`（连字符）404。所有其他 graph 端点都用斜杠（`/agentmemory/graph/query`、`/agentmemory/graph/extract`、`/agentmemory/graph/stats` 等）。

### 影响

- AC5（graph-build 后 graph 节点 > 0）从 spec 文档化的脚本路径不可达
- refine-backfill.py phase 4 必跑失败直到脚本作者自行修正
- spec AC 验证步骤会误导后续 reviewer / 自动测试

### 修复

把 spec line 201 改为 `POST /agentmemory/graph/build`，并在 P3 实施清单中加一条"验证 refine 脚本里的 HTTP 路径与 api.ts registerTrigger 一致"。

---

## 🟠 P1-1 · `if (raw.title)` 把空字符串当未压缩，触发无限重新入队 [CODE]

**文件**：spec 变更 3 代码块 line 160；关联 `src/functions/compress.ts:154`

### 问题

```ts
// spec 提议
if (raw.title) {
  return { status_code: 200, body: { skipped: true, reason: "already compressed" } };
}
```

两个失败模式：

1. **falsy-zero 陷阱**：`title === ''`（空字符串）也是 falsy → 不跳过 → 重新入队。但 `compress.ts:154` 路径 `return { success: false, error: "parse_failed" }` 实际不写入任何 title（success: false 让 caller 决定如何处理），不过若 LLM 部分成功产出 title=''（XML 中 `<title></title>`），mem::compress 仍会写入空 title
2. **synthetic title 误判**：buildSyntheticCompression 写入的 title 是基于 obs 内容的截断字符串，**有值**，会触发 `skipped` 返回 — 但这意味着 synthetic observation 永远不被 LLM 升级，spec 想"catch up backfill to LLM 质量"的目标无法达成

### 影响

- 边界 obs（LLM 偶发返回空 title）会无限重入队，refine phase 3 的 10-min 卡死阈值反复触发
- 真正需要 LLM 升级的 synthetic observation 因 title 已存在而被跳过，AC7 永远不成立
- 令牌成本随 refine 轮次线性增长

### 修复

```ts
// 双重检查：title 必须非空且 confidence 已设置
const isLLMCompressed =
  typeof raw.title === "string" &&
  raw.title.length > 0 &&
  typeof (raw as CompressedObservation).confidence === "number";
if (isLLMCompressed) {
  return { status_code: 200, body: { skipped: true, reason: "already compressed" } };
}
```

或：把"synthetic vs LLM"区分成独立字段（如 `compressionKind: "synthetic" | "llm"`），spec 设计阶段就引入。

---

## 🟠 P1-2 · iii-queue builtin adapter 无持久化、无并发上限、无 DLQ [CODE]

**文件**：`iii-config.yaml`（spec 引用 line 17-20）；spec 实施顺序 P0 line 256

### 问题

Spec 引用 "iii-config.yaml 已注册 iii-queue worker"，并把"持久化"列为 P0 验证项。但配置中 `adapter: builtin` 是**纯内存**队列（无 file_based / kv/file_based 持久化），且：

- 无 `maxConcurrency` / `maxJobs`
- 无 `visibilityTimeout`
- 无 `maxRetries` / DLQ 配置
- 无 queue depth 暴露指标

Spec 在 P1 改代码之前**只验证了持久化**，没验证其他 4 项；即使持久化通过，剩下 4 项的缺失仍会让 21K 批量的 catch-up 失控。

### 影响

- 引擎中途重启（部署、OOM、ctrl-C iii-engine）→ 全部 21K 队列任务消失
- LLM 429 时无 backoff 重试，单条任务永久卡死或丢弃
- 单 worker 串行 drain（无 maxConcurrency 配置）→ ~17h drain time，期间 live observe 入队堆积
- refine phase 3 看到无进展就 10-min 重入队，掩盖队列丢失（worker 视角"慢但有进展"，用户视角每条 obs 被 LLM 压缩 2-3×）

### 修复

修改 `iii-config.yaml`：

```yaml
- name: iii-queue
  config:
    adapter: kv  # 改为持久化 adapter，参照 iii-state 配置
    store_method: file_based
    queues:
      compress: { max_concurrency: 4, max_retries: 3, dlq: compress-dlq }
      graph:    { max_concurrency: 2, max_retries: 3, dlq: graph-dlq }
    # 或暴露 queue depth 指标给 refine 脚本读取
```

或在 spec 验证清单中**显式列出**这 5 项（持久化 / 并发 / 重试 / DLQ / 深度指标），未达标不进入 P1。

---

## 🟠 P1-3 · graph-extract 在 session::stopped 重试时重复处理同一批 observation [CODE]

**文件**：`src/triggers/events.ts:64-74`（spec 引用 line 73）

### 问题

```ts
// events.ts:64-74（当前）
const observations = await kv.list<CompressedObservation>(KV.observations(data.sessionId));
const compressed = observations.filter((o) => o.title);
if (compressed.length > 0) {
  sdk.trigger({
    function_id: "mem::graph-extract",
    payload: { observations: compressed },  // ← 全量 payload
    action: TriggerAction.Void(),  // ← spec 要改成 Enqueue
  });
}
```

每次 `session::stopped` 触发时，全量重读 + 全量入队。Spec 把 Void 改 Enqueue 后，phase 3 的 10-min 卡死重入队会让 `session::stopped` 重触发或 graph-extract 接收重叠 payload，每次重绘消耗 N 个 LLM token。

### 影响

- 对 100-obs session × 几次重试 = 数百个 LLM token 浪费
- 队列中 graph-extract 与 compress 共享同一 builtin adapter，无隔离（见深度问题 #2）

### 修复

加幂等键：

```ts
sdk.trigger({
  function_id: "mem::graph-extract",
  payload: {
    sessionId: data.sessionId,
    observationIds: compressed.map((o) => o.id),  // 只传 ID，不传全量
    schemaVersion: "v1",
  },
  action: TriggerAction.Enqueue({ queue: 'graph', idempotencyKey: `graph:${data.sessionId}:${compressed.length}` }),
});
```

或在 mem::graph-extract 内部加 `kv.list` 重读 + idempotency check。

---

## 🟡 P2-1 · Phase 2 串行 POST 无并发上限、无 429 退避、无断点续传 [SPEC]

**文件**：spec 变更 4 phase 2 line 185

### 问题

```python
# spec 设想
for observation in pending:
    POST /agentmemory/compress { sessionId, observationId }
```

20,987 条顺序 POST，单条 5xx 中断后无断点；脚本重跑无幂等记录区分"已入队"与"未入队"。Phase 3 10-min 卡死阈值的"重新入队未完成的"（line 198）也会触发同样的问题。

### 影响

- 墙钟 40+ 分钟，崩溃重跑翻倍
- 与 batch-summarize-backfill.py 的现成模式重复（`~/.agentmemory/.summarize_progress.json` Ctrl-C 安全续跑，spec 没引用）

### 修复

```python
# 复用 batch-summarize-backfill.py:35 的进度文件模式
PROGRESS = Path.home() / ".agentmemory" / ".refine_progress.json"
def load_progress() -> set: ...
def save_progress(done_ids: set): ...
# 并发 + 退避
async with httpx.AsyncClient() as client:
    sem = asyncio.Semaphore(32)
    async def post_one(obs):
        async with sem:
            for attempt in range(5):
                try:
                    r = await client.post(URL, json=obs, headers=auth_headers)
                    r.raise_for_status()
                    return obs["observationId"]
                except httpx.HTTPStatusError as e:
                    if e.response.status_code == 429:
                        await asyncio.sleep(2 ** attempt)
                    else:
                        raise
    await asyncio.gather(*[post_one(o) for o in pending])
```

---

## 🟡 P2-2 · Phase 1 无批量端点，3 步 O(sessions × obs) GET [SPEC]

**文件**：spec 变更 4 phase 1 line 180；关联 `src/triggers/api.ts:847` 的 api::observations 端点

### 问题

api::observations 要求 sessionId 查询参数、返回单个 session 的 observations。Spec phase 1 需要"遍历所有 backfill session"，但 spec 没说明怎么获取 session 列表（且"列出全部 sessions"端点可能有分页限制）。

### 影响

- Phase 1 自身墙钟 5-15 分钟
- 585 sessions × ~36 obs × 多次 GET = 大规模 KV 读
- 无进度文件 → 崩溃后从头开始

### 修复

选项 A：复用 `api::observations?sessionId=X` + 先调 sessions 列表（spec 文档化步骤）
选项 B：在 api.ts 加新端点 `GET /agentmemory/observations/index?prefix=backfill-` 返回 `(sessionId, observationId, hasTitle)` 三元组
选项 C：让 refine 直接用 `iii-sdk` 读 KV，跳过 REST

---

## 🟡 P2-3 · raw 入队 payload 制造陈旧写入窗口 [SPEC]

**文件**：spec 变更 3 代码块 line 165

### 问题

端点从 KV 读 raw → 作为 trigger payload 传给 mem::compress。在 kv.get 与 iii-queue drain 之间，dedup-merge（src/state/dedup.ts）可能把 KV.observations[obsId] 更新到 v2，但队列中仍携带 v1。Compress LLM 处理 v1，覆盖 v2 的合并形态。

频率低（要求 enqueue→drain 延迟 > dedup-merge 延迟），但 backfill 大批次 + 串行 drain 增加了发生概率。

### 修复

从 trigger payload 中移除 `raw`，让 mem::compress 按 observationId 在 drain 时重读：

```ts
// mem::compress 签名改为只接 ID
async (data: { observationId: string; sessionId: string }) => {
  const raw = await kv.get<RawObservation>(KV.observations(data.sessionId), data.observationId);
  if (!raw) throw new Error("observation not found");
  // ... 后续不变
}
```

---

## 🟡 P2-4 · Phase 3 轮询进度测量 ≈ 4300 万次 KV 操作 [SPEC]

**文件**：spec 变更 4 phase 3 line 188

### 问题

```python
# spec 设想
loop:
    sleep 30s
    重读全部入队过的 observation
    level 1: 全部有 title?
    level 2: 全部 confidence≥0.7?
    level 3: 全部 concepts>0?
    if 全部达标: break
    if 超过 10 分钟无进展: 重新入队未完成的
```

21K obs × 17h drain × 2040 polls = ~43M KV reads for progress only。无法区分"LLM 慢" / "被丢弃" / "队列卡死"。

### 修复

- 把"level 1/2/3"拆为：(a) 进度门控（title 是否有）作为退出条件，(b) 质量指标（confidence/concepts）作为**最终报告**而非门控
- 把 10-min 卡死阈值提到 ≥30min
- 若 iii-queue 暴露深度指标（见 P1-2 修复），改用 queue depth 变化率作为进度源
- 或订阅 iii stream 事件替代轮询（spec 提及 iii stream primitives）

---

## 战略 / 深度问题（影响 spec 整体方向）

### 🟠 SPEC-SCOPE-1 · 16 个 Void 调用只修 2 个 [SCOPE]

Spec 自己的 header line 9 承认"已发现的 16 处 Void 用法均无错误处理"，但只修 compress（observe.ts:295）和 graph-extract（events.ts:73）。剩下 13 处 Void（mem::auto-forget、mem::evict、mem::slot-reflect、mem::disk-size-delta、mem::vision-embed 等）在 live 用户那里继续静默丢弃工作。

**取舍依据**：spec 应论证为什么"只修 backfill 暴露的 2 个"。若理由是"避免范围爆炸"，应在 spec 内显式列为 deferred work，并附 issue 跟踪。否则下次 review 会反复质疑同样的取舍。

**替代深度**：项目级 lint 规则禁用 `TriggerAction.Void()` 用于非可观测性工作 / 提供 `sdk.fireAndForget()` 辅助函数，自动选择 queue or void 基于 function 元数据。

### 🟠 SPEC-SCOPE-2 · refine-backfill.py 是永久维护负担而非根因修复 [SCOPE]

根因是 `scripts/backfill-sessions.py` 摄入 observation 时不触发 compress。Spec 选择"事后 catch-up 脚本"而非"摄入即入队"。这意味着：

- 每次新 backfill 都需要跑 refine
- refine 崩溃/超时后状态不一致
- 与 `batch-summarize-backfill.py` 形成"补救脚本家族"（已是已知 wart）

**替代深度**：让 `scripts/backfill-sessions.py` 在 `POST /observe` 后立即调 `POST /agentmemory/compress`，backfill 天生入队，refine-backfill.py 只作为一次性历史 catch-up，运行后可弃用。

### 🟡 SPEC-SCOPE-3 · 共享 adapter 的两个队列名无隔离 [SPEC]

Spec line 140 承认 "iii-queue worker 不区分队列名, compress 和 graph 共用同一个 builtin adapter"，但 spec 仍给两个 queue 不同名字。共享 FIFO drain 下，命名不提供隔离、优先级或并发收益。

**影响**：AC7 在长 backfill 队列下会因 session::stopped graph-extract 被排在 21K compress 后面而失败。

**修复**：要么真在 `iii-config.yaml` 注册两个独立 worker（不同 maxConcurrency / 优先级），要么合并为一个 `post-observe` 队列。

---

## 修复优先级建议

| 顺序 | 项 | 工作量 | 阻塞 |
|------|-----|--------|------|
| 1 | P0-1（AUTO_COMPRESS 门控） | spec 改前置条件声明 + boot log 断言 | AC2/AC7 不可达 |
| 2 | P0-3（路径错误） | spec 改 line 201 | AC5 不可达 |
| 3 | P0-2（synthetic 误判） | 端点加类型守卫 / 改 mem::compress 签名 | 数据损坏 |
| 4 | P1-2（队列配置） | iii-config.yaml 改 adapter + 加并发/重试/DLQ | 引擎重启丢任务 |
| 5 | P1-1（falsy-zero） | 端点改 isLLMCompressed 守卫 | 无限重入队 |
| 6 | P1-3（graph-extract 幂等） | 加 idempotencyKey / observationIds | LLM 成本放大 |
| 7 | P2-* | 复用 batch-summarize-backfill.py 进度文件 + 并发客户端 | 运维效率 |
| 8 | SCOPE-* | 重新论证范围 / 拆 issue 跟踪 | 长期债务 |