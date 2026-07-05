# Issue — spec P0 修复内部冲突：P0-1 与 P1-1 守卫互相否定

**发现时间**：2026-07-04
**关联 spec**：`docs/superpowers/specs/2026-07-04-backfill-compression-fix-design.md`
**关联评审**：`docs/issues/2026-07-04-backfill-compression-design-review.md`（P0-1 / P1-1）

---

## 背景

按修复优先级表执行 P0 三项后，spec 的改动在 `src/functions/observe.ts` 和 `src/functions/compress.ts` 之间引入了**自相矛盾**的两条逻辑：

1. **observe 路径（变更 1, spec line 121-159）**：先无条件写 synthetic（有 title + confidence=0.3），再无条件 Enqueue LLM 升级
2. **mem::compress 入口（变更 2, spec line 174-188）**：`if (raw.title && typeof raw.confidence === "number") return { skipped: true }`

这两条同时执行时，mem::compress 读到 observe 刚写入的 synthetic → 命中 `title && confidence` 双真守卫 → **立即短路返回 skipped**。LLM 升级路径被自己的守卫堵死。

---

## 问题详述

### 数据形态证据

`synthetic` 在 KV 中长这样（`src/functions/compress-synthetic.ts:76-103`）：

```ts
export function buildSyntheticCompression(raw: RawObservation): CompressedObservation {
  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type: inferType(toolName, raw.hookType),
    title: truncate(toolName || "observation", 80),  // ← 有 title
    subtitle: ...,
    facts: [],
    narrative: truncate(narrativeParts.join(" | "), 400),
    concepts: [],
    files: extractFiles(raw.toolInput),
    importance: 5,
    confidence: 0.3,                                  // ← 有 confidence（数字）
  };
  // 注意：没有 hookType / toolName 字段（属于 RawObservation）
}
```

synthetic 同时**有** title 和 confidence（数字），但**没有** hookType / toolName。

### spec 的两条改动

**改动 A · observe（line 142-147）**：

```ts
// 先写 synthetic（不依赖 LLM，立即生效）
const synthetic = buildSyntheticCompression(raw);
await kv.set(KV.observations(payload.sessionId), obsId, synthetic);  // ← 写入 KV
getSearchIndex().add(synthetic);
await vectorIndexAddGuarded(synthetic.id, ...);
await streamSet(synthetic);

// 再入队 LLM 增强（无条件）
await sdk.trigger({
  function_id: "mem::compress",
  payload: { observationId, sessionId: payload.sessionId, raw },
  action: TriggerAction.Enqueue({ queue: 'compress' }),
});
```

**改动 B · mem::compress（line 174-188）**：

```ts
async (data: { observationId: string; sessionId: string }) => {
  const raw = await kv.get<RawObservation>(KV.observations(data.sessionId), data.observationId);
  if (!raw) throw new Error("observation not found");
  if (raw.title && typeof raw.confidence === "number") {
    return { success: false, skipped: true, reason: "already compressed" };  // ← P1-1 守卫
  }
  if (!("hookType" in raw) || !("toolName" in raw)) {
    return { success: false, skipped: true, reason: "synthetic observation, raw fields missing" };  // ← P0-2 守卫
  }
  if (!isAutoCompressEnabled()) {
    return { success: false, skipped: true, reason: "auto-compress disabled" };
  }
  // ... 后续 LLM 调用
}
```

### 失败路径

1. observe.ts 写入 synthetic（有 title、confidence=0.3，**无** hookType/toolName）
2. iii-queue drain → mem::compress 重读 → 拿到 synthetic
3. **P1-1 守卫命中**：title 真 && confidence 是数字 → 返回 `skipped: "already compressed"`
4. LLM 永远不被调用 → synthetic 形态永远是 synthetic → **AC7 永远不成立**

如果 P1-1 守卫被反过来设计成"title 或 confidence 缺失才升级"，又会破坏另一面：已经 LLM 压缩过的 observation 会被无意义地再次升级（双倍 token）。

---

## 根本原因

P1-1 守卫（评审时我自己提议）混淆了两种"已压缩"状态：

| 状态 | title | confidence | hookType/toolName | 应有行为 |
|------|-------|------------|-------------------|----------|
| **RawObservation**（未压缩） | undefined | undefined | 有 | LLM 压缩 |
| **synthetic**（AUTO_COMPRESS=false 默认产物） | 有 | 有 (0.3) | 无 | LLM 升级覆盖 |
| **LLM-compressed**（AUTO_COMPRESS=true 升级后） | 有 | 有 (≥0.7) | 无（类型是 CompressedObservation） | 跳过 |

当前的 P1-1 守卫无法区分 row 2 和 row 3 → 把 synthetic 误判为 LLM-compressed → LLM 升级永远不发生。

spec 的修复评审 P1-1 行原建议过引入 `compressionKind: "synthetic" | "llm"` 字段，但 spec 没采纳。

---

## 影响范围

### AC 影响

- ❌ **AC7 仍然结构性不可达**：默认部署（`AUTO_COMPRESS=false`）的 observation 写入后立即被守卫短路，backfill catch-up 后 live ≠ backfill 的目标不达成
- ⚠️ **AC2 表面成立**但实际空跑：observation 入队了，但每次都被 mem::compress 立即跳过，无 LLM 工作发生
- ✅ **AC1 / AC3 / AC4 / AC5 / AC6 不受影响**

### 资源影响

- iii-queue 仍然写入 file_based 持久化（21K 次磁盘写入），但全部在 drain 时被守卫丢弃
- queue 工作线程一直空转 / 收 rejected 任务
- 21K observations 的回填工作**没有产生任何 LLM 升级**，与 spec 的设计意图（统一 live/backfill 路径）完全相反

### 行为对比

| 路径 | spec 修复前的行为 | spec 修复后的行为 | 期望行为 |
|------|------------------|------------------|----------|
| live observe（`AUTO_COMPRESS=false` 默认） | synthetic 写入，不再变化 | synthetic 写入 + 入队 + 守卫跳过 + 仍是 synthetic | synthetic 写入 + LLM 升级 |
| live observe（`AUTO_COMPRESS=true`） | 立即 LLM 调（Void 丢弃） | synthetic 写入 + 入队 + LLM 调 + 覆盖 | synthetic 写入 + LLM 升级 |
| refine catch-up（`AUTO_COMPRESS=false`） | REST 端点 404（端点不存在） | REST 入队 + 守卫跳过 + 仍是 synthetic | REST 入队 + LLM 升级 |
| refine catch-up（`AUTO_COMPRESS=true`） | REST 端点 404 | REST 入队 + LLM 调 + 覆盖 | REST 入队 + LLM 升级 |

**关键观察**：默认部署下，spec 修复**没有改变行为** —— synthetic 仍然是 synthetic，spec 想要的"统一路径"实质上没建立。

---

## 三种修复方案

### 方案 A · 引入 `compressionKind` 字段（推荐）

**改动范围**：`src/types.ts` CompressedObservation 类型、`buildSyntheticCompression`、mem::compress 守卫

```ts
// types.ts
type CompressionKind = "synthetic" | "llm";
interface CompressedObservation {
  // ... 既有字段
  compressionKind?: CompressionKind;  // undefined = legacy pre-0.8.x
  llmConfidence?: number;             // 区分 synthetic 0.3 vs LLM 0.7+
}

// compress-synthetic.ts:105
return { ...result, compressionKind: "synthetic" };

// compress.ts mem::compress 守卫（替换 line 177-178）
if (raw.compressionKind === "llm" && raw.title && typeof raw.llmConfidence === "number" && raw.llmConfidence >= 0.7) {
  return { success: false, skipped: true, reason: "already LLM-compressed" };
}
// compressionKind === "synthetic" 或 undefined 都应升级
```

**优点**：
- 显式区分状态，可读性强
- 旧数据兼容（undefined 走升级路径，自然 drain）
- 为未来扩展（"hybrid"、"user-edited" 等）留空间

**缺点**：
- 需要数据迁移（既有 synthetic 数据无 `compressionKind` 字段）—— 但 spec 反正要重跑 backfill，顺带写入新字段即可

### 方案 B · observe 不写 synthetic，让 mem::compress 决策

**改动范围**：`src/functions/observe.ts`

```ts
// 移除 line 142-147 的 synthetic 写入
// 只入队，让 mem::compress drain 时根据 AUTO_COMPRESS 决定走 synthetic 还是 LLM
await sdk.trigger({
  function_id: "mem::compress",
  payload: { observationId, sessionId: payload.sessionId, raw },
  action: TriggerAction.Enqueue({ queue: 'compress' }),
});
// BM25/Vector 索引由 mem::compress 完成后的 stream 事件驱动
```

**优点**：
- 决策统一在一处（mem::compress 内部）
- 没有"synthetic 形态如何区分"的难题

**缺点**：
- ❌ 破坏 line 51 提到的"✅ 61% 命中率"特性 —— search 在 mem::compress drain 之前不可用
- mem::compress drain 延迟下，hook 立即返回但下游 search 拿不到这条 observation
- 改变 hook timeout 行为（CLAUDE.md 提到 hook 在 ~500ms 内退出 —— 现在变为立即返回，符合；但下游消费者要等 queue drain）

### 方案 C · 双守卫，synthetic 用 ttl 标记

**改动范围**：synthetic 写入加 ttl 字段，mem::compress 守卫检查 ttl

```ts
// compress-synthetic.ts
result.compressionKind = "synthetic";
result.syntheticAt = Date.now();  // 时间戳

// compress.ts
if (raw.compressionKind === "llm") return skipped;
if (raw.compressionKind === "synthetic" && (Date.now() - raw.syntheticAt) < 60_000) {
  // synthetic 写入后 60s 内不重试（避免与 observe 路径抢着写入）
  return skipped;
}
```

**优点**：
- 不破坏现有搜索可用性
- 不引入新字段语义

**缺点**：
- ⚠️ 时间窗口依赖：60s 太短，drain 慢的 observation 会被重复升级；60s 太长，第一次升级失败后无法重试
- 引入隐式时间假设，难以测试

---

## 推荐方案

**方案 A（`compressionKind` 字段）**。理由：

1. spec 原本就讨论过类似机制（评审 P1-1 建议），作者已熟悉
2. 显式状态机优于隐式时间窗口
3. 数据迁移可与 spec 整体改造一并执行
4. 与 spec 现有 line 51 提到的"最终状态一致"目标契合 —— live 和 backfill 最终都是 `compressionKind: "llm"`

---

## 关联需要同步的修复

### 阻塞此项的依赖

- **P0-2 类型守卫位置错位**：spec line 180-182 的 `if (!("hookType" in raw))` 同样把 synthetic 拒之门外。需要重写为基于 `compressionKind` 的判断
- **P2-3 stale-write**：方案 A 下，因为不再传 raw payload，这个已自然解决
- **观测/诊断**：boot log 需要新增 `compressionKind` 分布统计（live + backfill 的 LLM 升级率）

### 不被此项阻塞但应一并审视

- **API 契约破坏**（评审发现 3）：mem::compress 签名从 3 字段改 2 字段，所有调用方需同步。grep 结果显示至少 5 处：
  - `src/functions/observe.ts:287-296`
  - tests in `test/`
  - 任何 MCP tool 注册的 compress 调用
  - 任何 plugin 脚本的 compress 调用
  - refine-backfill.py 文档示例

---

## 修复优先级

🔴 **P0-0** — 在 spec 进入实施 P1 之前必须解决，否则 P0-1/P0-2/P1-1 三项修复组合无效

---

## 验证方法

实施后跑以下 dry-run：

1. **fresh observation（无 synthetic 残留）**：
   - POST /observe → 检查 KV 有 synthetic + 有 `compressionKind: "synthetic"`
   - 等 queue drain → 检查 KV 有 `compressionKind: "llm"` + LLM 标题
2. **legacy observation（backfill 既有数据，无 compressionKind）**：
   - POST /compress → mem::compress 守卫不命中（undefined）→ 走 LLM 升级路径
   - KV 写入 `compressionKind: "llm"` + LLM 标题
3. **already-LLM observation**：
   - POST /compress → 守卫命中（`compressionKind === "llm" && llmConfidence >= 0.7`）→ 跳过，无 LLM 调用
   - 验证 metrics：token 消耗仅来自新升级，不来自重复升级

---

## 给 spec 作者的快速补丁建议

如果不想大改 `compressionKind` 字段，最小修复是**改 observe 流程**：不写 synthetic，让 mem::compress 决策（方案 B），并在 spec 验收里**显式承认 search 在 queue drain 之前不可用**（修改 line 51）。

这条最小修复不需要新字段、不需要数据迁移、不破坏既有类型守卫 —— 代价是 search 延迟。这是**保底方案**，应优先于方案 A 实施（如果时间紧迫）。

如果选择保留 synthetic 立即写入的体验（保持 61% 命中率），则必须走方案 A（`compressionKind`）—— 没有第三条路。