# 设计：统一 live/backfill 压缩路径

**日期**：2026-07-04
**来源**：
- 本次 backfill 执行（585 session，~21K observations）
- `src/functions/observe.ts` async compress 使用 `TriggerAction.Void()`，密集请求被丢弃
- iii-sdk 提供 `TriggerAction.Enqueue`（`node_modules/iii-sdk/dist/index.d.mts:49-55`，参数只有 `queue: string`，无 `idempotencyKey`）
- `iii-config.yaml` 已注册 `iii-queue` worker（adapter: builtin，in-memory）
- **iii-engine 0.11.2 runtime 验证**（2026-07-04 实际启动测试）：`name: builtin + store_method: file_based` 是正确写法；`queue_configs` map + `concurrency` / `max_retries` / `backoff_ms` / `message_group_field` 字段名正确；`dlq` / `max_concurrency` / `queue_kv` 都被 engine 严格拒绝（错误信息明示合法字段集）
- **Engine Enqueue 路由规则**（2026-07-04 实际启动 + queue_configs 行为观察）：`TriggerAction.Enqueue({ queue })` 的 `queue` 参数**必须精确匹配 function_id**（如 `'mem::compress'`），简写（`'compress'`）会路由到默认 queue，per-function config 不生效
- 设计评审 #1：`docs/issues/2026-07-04-backfill-compression-design-review.md`（10 条发现）
- 设计评审 #2：`docs/issues/2026-07-04-spec-p0-fix-internal-collision.md`（P0-1 与 P1-1 自相矛盾）
- 设计评审 #3：`docs/issues/2026-07-04-spec-v2-remaining-issues.md`（第二轮修订剩余问题：P0-7 / P2-5 / P1-4 / P1-5）

---

## 核心意图

抹平 live session 与历史记录（backfill）的压缩路径差异，使所有 observation 统一经历 `observe → Enqueue → iii-queue → LLM compressed`，最终状态一致。

---

## Backfill 背景

### 为什么做 backfill

OMP agent 的 session 记录保存在 `~/.omp/agent/sessions/`，613 个文件、50+ 项目、约 8 个月的历史。Backfill 的目的是把这些历史注入 agentmemory，使 agent 能检索这些上下文，与 live session 产生的记忆完全一致。

### 当前状态

| 指标 | 数值 |
|------|------|
| 已导入 sessions | 585 |
| 已导入 observations | ~21,000 |
| 有 summary 的 session | 13（2%）|
| 搜索可用 | ✅ 61% 命中率 |
| Graph | ❌ backfill 数据未入图 |

---

## 方案

### 核心数据模型变更：`compressionKind`

**问题**（评审 #2）：observe 写入 synthetic（有 `title` + `confidence: 0.3`），mem::compress 收到后命中 `if (raw.title && typeof raw.confidence === "number")` → 跳过 → LLM 永远不跑。无法区分 synthetic 和 LLM-compressed。

**修复**：`CompressedObservation` 加 `compressionKind` 字段。

```typescript
// src/types.ts
type CompressionKind = "synthetic" | "llm";

interface CompressedObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: ObservationType;
  title: string;
  subtitle?: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  confidence?: number;
  compressionKind: CompressionKind;    // ← 新增
  compressionVersion: 1;               // ← 新增，方便未来 schema 升级
  // RawObservation 字段（仅 synthetic 有，LLM 压缩后删除）
  hookType?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  userPrompt?: string;
  imageData?: string;
  agentId?: string;
}
```

**状态机**：

```
RawObservation（无 title/confidence/compressionKind）
  → synthetic 写入（compressionKind: "synthetic", confidence: 0.3, 保留 hookType/toolName）
    → LLM 覆盖（compressionKind: "llm", confidence: 0.5-1.0, 删除 hookType/toolName）
```

**mem::compress 守卫**：

```typescript
// compress.ts 入口
if (raw.compressionKind === "llm") {
  return { success: false, skipped: true, reason: "already LLM-compressed" };
}
// compressionKind === "synthetic" 或 undefined（旧数据）→ 走 LLM 升级
```

### 架构

```
                    ┌──────────────────────────────────────┐
                    │          iii-queue                    │
                    │  ┌──────────┐  ┌──────────┐          │
  observe ──────────┤  │compress  │  │graph     │          │
  compress 端点 ────┤  │(持久化)   │  │(持久化)   │          │
  session::stopped ─┤  │max_conc:4│  │max_conc:2│          │
                    │  │max_retry:3│  │max_retry:3│          │
                    │  └────┬─────┘  └────┬─────┘          │
                    └───────┼──────────────┼───────────────┘
                            │              │
                            ▼              ▼
              KV.observations        KV.graphNodes/Edges
              { compressionKind }
                    │
               ┌────┼────┐
               ▼    ▼    ▼
          summar  consol  search
```

### 变更 0：`iii-config.yaml` — 队列持久化 + per-function 配置

**已验证**（iii-engine 0.11.2，2026-07-04 实际启动测试）：

| 配置项 | 结果 |
|--------|------|
| `adapter.name: builtin` | ✅ 接受，持久化通过 `adapter.config.store_method: file_based` 启用（**不是单独的 `queue_kv` adapter**）|
| `adapter.name: queue_kv` | ❌ 拒绝（`Adapter factory 'queue_kv' not found. Available: ["bridge", "redis", "rabbitmq", "builtin"]`）|
| `adapter.name: redis` / `rabbitmq` | 推测 ✅（在可用列表），但需外部依赖 |
| `queue_configs` map 字段 | ✅ 接受，启动时日志确认：<br>`Started function queue consumer queue: mem::compress type: standard concurrency: 4`<br>`Started function queue consumer queue: mem::graph-extract type: standard concurrency: 2` |
| `dlq` 字段 | ❌ 拒绝（`unknown field 'dlq'`），engine 自动 per-queue 维护 `<fn_id>.dlq` |
| `max_concurrency` 字段 | ❌ 拒绝（`unknown field 'max_concurrency'`），正确字段名是 `concurrency` |
| FunctionQueueConfig 合法字段集 | `max_retries, concurrency, type, message_group_field, backoff_ms, poll_interval_ms`（engine 错误信息明示）|

**YAML（已验证可启动）**：

```yaml
- name: iii-queue
  config:
    adapter:
      name: builtin                    # ← 正确名（不是 queue_kv）
      config:
        store_method: file_based       # ← 持久化关键
        file_path: ./data/queue_store
    queue_configs:                     # map: function_id → FunctionQueueConfig
      "mem::compress":
        concurrency: 4
        max_retries: 3
        backoff_ms: 1000
        message_group_field: observationId   # 同 observationId 串行化
      "mem::graph-extract":
        concurrency: 2
        max_retries: 3
        backoff_ms: 1000
        message_group_field: sessionId        # 同 session 串行化
```

**关于 DLQ**：engine 自动按 queue 创建 `<function_id>.dlq` topic。已注册 function：`iii::queue::redrive`, `iii::queue::redrive_message`, `iii::queue::discard_message`, `engine::queue::list_topics`, `engine::queue::topic_stats`, `engine::queue::dlq_topics`, `engine::queue::dlq_messages`（启动日志确认）。

### 变更 1：`src/types.ts` — 新增 `compressionKind` 字段

```typescript
type CompressionKind = "synthetic" | "llm";
interface CompressedObservation {
  // ... 既有字段
  compressionKind: CompressionKind;
  compressionVersion: 1;
}
```

### 变更 2：`src/functions/compress-synthetic.ts` — 标记 `compressionKind: "synthetic"`

```typescript
return { ...result, compressionKind: "synthetic", compressionVersion: 1 };
```

### 变更 3：`src/functions/compress.ts` — 改签名 + 守卫

**签名改为只接 ID，drain 时重读 KV（修复 P0-2 / P2-3 stale-write 与 synthetic 误判）**：

```typescript
async (data: { observationId: string; sessionId: string }) => {
  // P0-7 修复：从 KV 重读 raw，函数体内所有字段访问改用此变量
  const raw = await kv.get<RawObservation | CompressedObservation>(
    KV.observations(data.sessionId),
    data.observationId
  );
  if (!raw) throw new Error("observation not found");

  // P1-1 守卫：已 LLM 压缩 → 跳过（用 compressionKind 区分而非 title，避免 synthetic 误判）
  if (raw.compressionKind === "llm") {
    return { success: false, skipped: true, reason: "already LLM-compressed" };
  }

  // P0-1 守卫：未压缩 / synthetic / 旧数据 → 升级；AUTO_COMPRESS=false 时短路
  if (!isAutoCompressEnabled()) {
    return { success: false, skipped: true, reason: "auto-compress disabled" };
  }

  // P0-7 修复：从 raw 计算 hasImage（之前从 data.raw 读取，新签名下 data.raw 不存在）
  const hasImage = raw.modality === "image" || raw.modality === "mixed";

  // 【P0-5 修复】不能直接传 raw（synthetic 没有 hookType，TS 编译失败；imageDescription 注入逻辑也会丢）
  // 显式解构字段 + 保留 imageDescription 三元表达式
  const prompt = buildCompressionPrompt({
    hookType: raw.hookType ?? "synthetic",  // 兜底：synthetic 没 hookType
    toolName: raw.toolName,
    toolInput: raw.toolInput,
    toolOutput: imageDescription
      ? `[Image Description]: ${imageDescription}\n\n${raw.toolOutput ?? ""}`
      : raw.toolOutput,
    userPrompt: raw.userPrompt,
    timestamp: raw.timestamp,
  });
  const response = await provider.compress(prompt);
  const parsed = parseCompressionXml(response);
  if (!parsed) return { success: false, error: "parse_failed" };
  const qualityScore = scoreCompression(parsed);

  // P0-5 修复：显式标记 LLM 压缩完成 + schema 版本
  // 缺这两个字段会导致 AC3 失败（drain 后 KV 的 compressionKind 仍是 undefined）
  const compressed: CompressedObservation = {
    id: data.observationId,
    sessionId: data.sessionId,
    timestamp: raw.timestamp,         // P0-7：从 raw 读取
    ...parsed,
    confidence: qualityScore / 100,
    ...(hasImage ? { modality: raw.modality } : {}),          // P0-7
    ...(imageDescription ? { imageDescription } : {}),
    ...(raw.imageData ? { imageRef: raw.imageData } : {}),    // P0-7
    ...(raw.agentId ? { agentId: raw.agentId } : {}),         // P0-7
    compressionKind: "llm",
    compressionVersion: 1,
  };

  await kv.set(KV.observations(data.sessionId), data.observationId, compressed);

  // search index / vector index / stream（与现状相同）
}
```

**注意**：spec 之前仅展示守卫 + 压缩结果构造，跳过了中间函数体。实施时务必把 `data.raw.*` 全部改为 `raw.*`，否则 TypeScript 编译失败（`npm test` 在 P3 阶段会全部报错）。

### 变更 4：`src/functions/observe.ts` — Enqueue 移出门控 + synthetic 先行

```typescript
// 先写 synthetic（不依赖 LLM，立即搜索可用，compressionKind: "synthetic"）
const synthetic = buildSyntheticCompression(raw);
await kv.set(KV.observations(payload.sessionId), obsId, synthetic);
getSearchIndex().add(synthetic);

// 【P2-7 修复】vectorIndexAddGuarded 必须传完整参数：id / sessionId / text(title+narrative) / metadata
await vectorIndexAddGuarded(
  synthetic.id,
  synthetic.sessionId,
  synthetic.title + " " + (synthetic.narrative || ""),
  { kind: "synthetic", logId: synthetic.id },
);

// 【P1-4 修复】需要 2 次 stream::set：per-session group + viewer group（与现状一致）
await sdk.trigger({
  function_id: "stream::set",
  payload: {
    stream_name: STREAM.name,
    group_id: STREAM.group(payload.sessionId),
    item_id: obsId,
    data: { type: "compressed", observation: synthetic },
  },
});
await sdk.trigger({
  function_id: "stream::set",
  payload: {
    stream_name: STREAM.name,
    group_id: STREAM.viewerGroup,
    item_id: obsId,
    data: {
      type: "compressed",
      observation: synthetic,
      sessionId: payload.sessionId,
    },
  },
});

// 【P0-4 修复】queue 名必须是 function_id 全名 'mem::compress'，否则 queue_configs 里的
// concurrency: 4 / message_group_field 配置不生效，21K obs 会退化到串行 1
await sdk.trigger({
  function_id: "mem::compress",
  payload: { observationId, sessionId: payload.sessionId },
  action: TriggerAction.Enqueue({ queue: 'mem::compress' }),
});
```

**为什么无条件**：`mem::compress` 内部自己判断 `AUTO_COMPRESS`。observe 不需要知道配置。

### 变更 5：`src/triggers/events.ts` — graph-extract 入队 + 幂等

**P2-5 修复**：filter 必须兼容旧数据（无 compressionKind 字段），否则 21K 旧 backfill observation 永远不进 graph-extract，AC9（live ≈ backfill）失败。

```typescript
if (isGraphExtractionEnabled()) {
  const observations = await kv.list<CompressedObservation>(KV.observations(data.sessionId));
  // P2-5 兼容旧数据：有 compressionKind="llm" 或（无 compressionKind 且 confidence>=0.7）都算 LLM 压缩
  const compressed = observations.filter((o) =>
    o.compressionKind === "llm" ||
    (o.compressionKind === undefined &&
     typeof o.confidence === "number" &&
     o.confidence >= 0.7)
  );
  if (compressed.length > 0) {
    sdk.trigger({
      function_id: "mem::graph-extract",
      payload: { sessionId: data.sessionId, observationIds: compressed.map((o) => o.id) },
      // 【P0-4 修复】queue 名必须是 'mem::graph-extract'，与 queue_configs key 一致
      action: TriggerAction.Enqueue({ queue: 'mem::graph-extract' }),
    });
  }
}
```

### 变更 6：`src/triggers/api.ts` — compress REST 端点

```typescript
sdk.registerFunction("api::compress", async (req) => {
  const authErr = checkAuth(req, secret);
  if (authErr) return authErr;
  const body = req.body as Record<string, unknown>;
  const sessionId = asNonEmptyString(body["sessionId"]);
  const observationId = asNonEmptyString(body["observationId"]);
  if (!sessionId || !observationId) {
    return { status_code: 400, body: { error: "sessionId and observationId required" } };
  }
  const result = await sdk.trigger({
    function_id: "mem::compress",
    payload: { sessionId, observationId },
    // 【P0-4 修复】queue 名必须是 'mem::compress'，与 queue_configs key 一致
    action: TriggerAction.Enqueue({ queue: 'mem::compress' }),
  });
  return { status_code: 200, body: result };
});
```

### 变更 7：`scripts/refine-backfill.py` — 存量 catch-up + 质量验证

断点续传（复用 `batch-summarize-backfill.py` 模式）、并发 32、429 退避。

```
phase 1: 快照
  GET sessions → 逐 session GET observations
  记录 { obsId, compressionKind, confidence }
  区分: llm / synthetic / 无

phase 2: 入队
  对 synthetic + 无 compression 的 observation:
    POST /agentmemory/compress（并发 32 + 退避 + .refine_progress.json）

phase 3: 验证
  每 60s 轮询:
    进度门控: 全部 compressionKind 变为 llm？
    最终报告: confidence / concepts 统计
  如果 30 分钟无进展 → 重新入队卡住的

phase 4: catch-up
  POST /agentmemory/graph/build
  POST /agentmemory/consolidate-pipeline
```

### 变更 8：`scripts/backfill-sessions.py` — 摄入即入队

在当前 session 的 observations 全部发送完后，逐条调 `POST /agentmemory/compress`。新 backfill 不需要 refine-backfill.py。

---

## 设计评审发现处理状态

| # | 严重度 | 问题 | 处理 |
|---|--------|------|------|
| P0-0 | 🔴 | P0-1 与 P1-1 互相否定（评审 #2） | `compressionKind` 字段区分 synthetic/LLM |
| P0-1 | 🔴 | Enqueue 在 AUTO_COMPRESS 门控内 | 移出门控，always Enqueue |
| P0-2 | 🔴 | compress 端点把 synthetic 当 raw 传 | compress 按 ID 重读，不依赖调用方传 raw |
| P0-3 | 🔴 | graph-build 路径写错 | `POST /agentmemory/graph/build` |
| P0-4 | 🔴 | iii-sdk 0.11.2 无 `idempotencyKey` 字段（变更 5 编译会失败） | 从 `TriggerAction.Enqueue` 调用中移除；graph-extract 重试去重依赖 engine `max_retries: 3` |
| P0-5 | 🔴 | `mem::compress` LLM 出口未显式写 `compressionKind: "llm"` → 整个数据模型修复原地失效 | 变更 3 增加 `compressed.compressionKind: "llm", compressionVersion: 1` 显式赋值 |
| P0-6 | 🔴 | iii-queue adapter name 写错：spec 写 `queue_kv`，实际是 `builtin` | **已验证修正**：`name: builtin` + `config: { store_method: file_based, file_path: ... }` 是正确写法 |
| P0-7 | 🔴 | mem::compress 签名改了但函数体仍访问 `data.raw.*`（编译失败） | 变更 3 补全函数体骨架，所有 `data.raw.*` 改为 `raw.*`，显式计算 `hasImage` |
| P0-8 | 🔴 | Enqueue 的 `queue` 写成简称 `'compress'`/`'graph'`，与 queue_configs key（`'mem::compress'`/`'mem::graph-extract'`）不匹配 → per-function config（concurrency 4）不生效，21K obs 退化为串行 | 变更 4/5/6 Enqueue 改为 `queue: 'mem::compress'` 和 `queue: 'mem::graph-extract'` |
| P0-9 | 🔴 | `buildCompressionPrompt(raw)` 直接传 raw：synthetic 无 `hookType` 必填字段 → TS 编译失败；imageDescription 注入逻辑也丢失 | 变更 3 显式解构 + 保留 imageDescription 三元表达式 + `raw.hookType ?? "synthetic"` 兜底 |
| P1-6 | 🟠 | observe.ts 写 2 次 `stream::set`（group_id + viewerGroup）+ `vectorIndexAddGuarded` 完整参数 | 变更 4 补全 2 次 stream::set + vectorIndexAddGuarded 完整 4 参数 |
| P2-5 | 🟡 | events.ts filter 用 `compressionKind === "llm"`，旧数据无此字段 → 21K 旧 obs 永远不进 graph-extract | 变更 5 filter 兼容旧数据：`compressionKind === undefined && confidence >= 0.7` 也算 llm |
| P1-1 | 🟠 | `if (raw.title)` falsy-zero | `compressionKind === "llm"` 代替 |
| P1-2 | 🟠 | iii-queue 无持久化/并发/重试 | `name: builtin + store_method: file_based` adapter（**已验证**，不是 `queue_kv`）+ per-function `queue_configs` 持久化（YAML 见变更 0）|
| P1-3 | 🟠 | graph-extract 重试重复 | 已知 trade-off：依赖 `message_group_field: sessionId` 串行化避免并发 LLM；接受重复成本（同 session 多次 session::stopped → 多次 graph-extract 调用，每次 LLM 重读全部 observation 重新生成节点，去重由 mem::graph-extract 内部承担，P10 端到端验证）。iii-sdk 0.11.2 无 idempotencyKey 字段 |
| P2-1 | 🟡 | refine 脚本无并发/续传 | 复用 batch-summarize 进度文件 |
| P2-2 | 🟡 | Phase 1 无批量端点 | 分页 fetch |
| P2-3 | 🟡 | raw payload 陈旧写入 | compress 按 ID 重读，不发 raw |
| P2-4 | 🟡 | 轮询 43M KV 读 | title→进度，confidence→报告 |
| SCOPE-1 | 🟠 | 只修 2/16 处 Void | 已确认范围：compress+graph |
| SCOPE-2 | 🟠 | refine 是永久负担 | backfill-sessions.py 摄入即入队 |
| SCOPE-3 | ✅ | 两队列无隔离 | **已验证**：`queue_configs` map 提供 per-function 独立 concurrency（4 / 2）+ max_retries + message_group_field；engine 启动日志显示 2 个独立 consumer |

---

## 验收条件

**环境前置标注**：AC3 / AC6 / AC7 / AC8 / AC9 需要 `AGENTMEMORY_AUTO_COMPRESS=true`（默认部署为 false，LLM 升级路径不触发，详见 P0-1 守卫）。AC1 / AC2 / AC4 / AC5 与 AUTO_COMPRESS 无关。

```
AC1: npm test 全部通过
AC2: POST /agentmemory/observe → synthetic 写入（compressionKind: "synthetic"）+ 入队
AC3: queue drain 后 → KV 中 compressionKind 变为 "llm"
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true；默认部署 drain 后 compressionKind
  保持 "synthetic"，符合产品决策（节省 token）。
  [H1 验证点] drain 后必须**显式可读**到 `"llm"`，不是 undefined——依赖变更 3 显式赋值
AC4: POST /agentmemory/compress（synthetic 数据）→ compressionKind 变为 "llm"
  [环境前置] 同 AC3
AC5: POST /agentmemory/compress（已有 LLM 数据）→ skipped，不消耗 token
  （与 AUTO_COMPRESS 无关）
AC6: crisp 146 session catch-up 后 summarize 成功
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true
AC7: POST /agentmemory/graph/build → graph 节点 > 0
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true；默认部署 graph-extract 不可达是已知 trade-off
AC8: consolidate 新产出 > 0
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true
AC9: 小项目 backfill 重跑（含变更 8）→ 结果与 live session 无差异
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true
  [数据前置] 历史 backfill observation（无 compressionKind 字段）必须经过变更 7 refine 或
  一次性迁移脚本标记，否则旧数据不进 graph-extract，AC9 失败
```

## 实施顺序

| Phase | 内容 | 文件 |
|-------|------|------|
| P0 | types.ts 加 compressionKind | `src/types.ts` |
| P1 | compress-synthetic.ts 标记 compressionKind | `src/functions/compress-synthetic.ts` |
| P2 | iii-config.yaml 队列持久化 | `iii-config.yaml` |
| P3 | compress.ts 改按 ID 重读 + compressionKind 守卫 | `src/functions/compress.ts` |
| P4 | observe.ts Enqueue 移出门控 + synthetic 先行 | `src/functions/observe.ts` |
| P5 | events.ts graph-extract 入队 | `src/triggers/events.ts` |
| P6 | api.ts compress 端点 | `src/triggers/api.ts` |
| P7 | refine-backfill.py 存量 catch-up | `scripts/refine-backfill.py` |
| P8 | backfill-sessions.py 摄入即入队 | `scripts/backfill-sessions.py` |
| P9 | 端点计数同步（AGENTS.md 清单） | 8 文件 |
| P10 | crisp 端到端验收 | — |
