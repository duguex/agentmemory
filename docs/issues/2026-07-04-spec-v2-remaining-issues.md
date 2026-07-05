# Issue — spec 第二轮修订剩余问题

**发现时间**：2026-07-04
**关联 spec**：`docs/superpowers/specs/2026-07-04-backfill-compression-fix-design.md`（第二轮修订）
**关联评审**：
- #1 `docs/issues/2026-07-04-backfill-compression-design-review.md`（首轮评审）
- #2 `docs/issues/2026-07-04-spec-p0-fix-internal-collision.md`（P0-1/P1-1 矛盾）

---

## 概述

第二轮 spec 修订显著好于第一版：
- ✅ 引入 `compressionKind` 字段正确解决了 issue #2
- ✅ 通过 iii-engine 0.11.2 实际启动验证，修正了 `queue_kv` → `builtin + store_method: file_based`
- ✅ 移除了原评审中所有阻塞 P0 项（除 SCOPE-1）
- ✅ 接受了 iii-sdk 0.11.2 无 `idempotencyKey` 的现实，转而依赖 engine 层 `max_retries: 3`

但**第二轮修订本身引入了 4 个新问题**，其中 2 个会阻塞 P3 / P10 实施。

---

## 🔴 P0-7 · mem::compress 签名改了但函数体仍访问 `data.raw.*`（编译失败）

**位置**：spec 变更 3 line 175-216；实际 `src/functions/compress.ts:82/84/89/112-119/162/165-168`

### 问题

spec 把签名改为 `{ observationId: string; sessionId: string }`（line 177），移除了 `raw: RawObservation`。但函数体在多个位置仍访问 `data.raw.*`：

```ts
// compress.ts:82
const hasImage = data.raw.modality === "image" || data.raw.modality === "mixed";
// compress.ts:84
provider.describeImage({ data: data.raw.imageData, ... })
// compress.ts:112-119
hookType: data.raw.hookType,
toolName: data.raw.toolName,
toolInput: data.raw.toolInput,
toolOutput: data.raw.toolOutput,
userPrompt: data.raw.userPrompt,
// compress.ts:162
timestamp: data.raw.timestamp,
// compress.ts:165
...(hasImage ? { modality: data.raw.modality } : {}),
// compress.ts:167
...(data.raw.imageData ? { imageRef: data.raw.imageData } : {}),
// compress.ts:168
...(data.raw.agentId ? { agentId: data.raw.agentId } : {}),
```

`data.raw` 在新签名下不存在 — TypeScript 应在编译时拒绝。`npm test` 在 P3 阶段会全部失败。

### 修复

spec 变更 3 line 178 后需要补一行：

```ts
const raw = await kv.get<RawObservation | CompressedObservation>(
  KV.observations(data.sessionId),
  data.observationId
);
if (!raw) throw new Error("observation not found");
```

然后把函数体里所有 `data.raw.*` 改为 `raw.*`。spec 当前在 line 178 已经写了 `const raw = await kv.get(...)` 但没展示后续用法，读者会以为函数体不需要 raw —— **spec 必须明确展示函数体如何访问 raw 字段**，否则实施者会按现有 compress.ts 抄代码，签名改了但 body 没改，编译失败。

### 验证方法

实施后：

```bash
npm run build  # 必须无 TS 错误
npx vitest run test/compress.test.ts  # 必须通过
```

---

## 🔴 P2-5 · spec 变更 5 filter 用 `compressionKind === "llm"`，但旧数据无此字段

**位置**：spec 变更 5 line 244

### 问题

```ts
const observations = await kv.list<CompressedObservation>(KV.observations(data.sessionId));
const compressed = observations.filter((o) => o.compressionKind === "llm");
```

旧数据（变更 1 实施前的 585 sessions / 21K observations）**没有 `compressionKind` 字段**。`undefined === "llm"` 为 false → 21K 旧 observation **永远不进入 graph-extract**。

这与 spec 变更 8（backfill-sessions.py 摄入即入队）的目标**自相矛盾**：
- 摄入即入队升级到 llm → 新 backfill 数据有 compressionKind="llm"
- 旧 backfill 数据没经过新流程 → compressionKind=undefined → 不被 graph 处理
- AC9（小项目 backfill 重跑 → 结果与 live session 无差异）失败：live session 有 graph 节点，backfill 没有

### 修复

spec 变更 5 line 244 filter 改为兼容旧数据：

```ts
const compressed = observations.filter((o) =>
  o.compressionKind === "llm" ||
  // 旧数据兜底：有 title + confidence 是数字 → 视为 llm-compressed
  (o.compressionKind === undefined &&
   typeof o.confidence === "number" &&
   o.confidence >= 0.7)
);
```

或在变更 7（refine phase 4 catch-up）之前增加 "backfill 历史数据 compressionKind 迁移" phase，把旧 observation 标记为 llm（如果有 LLM 标题）或 synthetic。

---

## 🟠 P1-4 · AC3 / AC9 缺环境前置标注（与 AC7 不一致）

**位置**：spec AC line 336 / 342

### 问题

AC7 已标注 "`AGENTMEMORY_AUTO_COMPRESS=true`；默认部署 graph-extract 不可达是已知 trade-off"（line 340），但 AC3（drain 后 compressionKind=llm，line 336）和 AC9（小项目 backfill 重跑结果与 live 无差异，line 342）未标注。

AC3 在默认部署下 KV 永远是 synthetic，AC9 同理 —— 验收必失败。读者会以为 AC3 / AC9 默认可达。

### 修复

把 AC3 / AC9 也加环境前置标注：

```text
AC3: queue drain 后 → KV 中 compressionKind 变为 "llm"
  [环境前置] AGENTMEMORY_AUTO_COMPRESS=true；默认部署 drain 后
  compressionKind 保持 "synthetic"，符合产品决策（节省 token）。

AC9: 小项目 backfill 重跑 → 结果与 live session 无差异
  [环境前置] 同 AC3。
```

或拆为子集：

```text
AC3a: AUTO_COMPRESS=true → drain 后 compressionKind === "llm"
AC3b: AUTO_COMPRESS=false → drain 后 compressionKind 仍为 "synthetic"（守卫命中）
AC9a: AUTO_COMPRESS=true → live 与 backfill graph 节点数差异 < 5%
AC9b: AUTO_COMPRESS=false → live 与 backfill compressionKind 分布一致
```

---

## 🟠 P1-5 · spec line 200 引用 `data.raw.timestamp` 但新签名无 raw（与 P0-7 重叠）

**位置**：spec 变更 3 line 198-211（compressed 对象构造）

### 问题

```ts
const compressed: CompressedObservation = {
  id: data.observationId,
  sessionId: data.sessionId,
  timestamp: data.raw.timestamp,  // ← data.raw 不存在
  ...parsed,
  confidence: qualityScore / 100,
  ...(hasImage ? { modality: data.raw.modality } : {}),  // ←
  ...(imageDescription ? { imageDescription } : {}),
  ...(data.raw.imageData ? { imageRef: data.raw.imageData } : {}),  // ←
  ...(data.raw.agentId ? { agentId: data.raw.agentId } : {}),  // ←
  compressionKind: "llm",
  compressionVersion: 1,
};
```

同 P0-7，但额外指出 `hasImage` 变量在 spec 中未定义（line 204），需要从 raw 计算。

### 修复

与 P0-7 一并 —— spec 必须展示完整的 drain 函数体，包括 `hasImage` 计算和 raw 重读，不能只展示守卫 + 压缩结果构造。

建议补全后的完整函数体骨架：

```ts
async (data: { observationId: string; sessionId: string }) => {
  const raw = await kv.get<RawObservation | CompressedObservation>(
    KV.observations(data.sessionId),
    data.observationId
  );
  if (!raw) throw new Error("observation not found");

  // P1-1 守卫（已 LLM 压缩）
  if (raw.compressionKind === "llm") {
    return { success: false, skipped: true, reason: "already LLM-compressed" };
  }

  // P0-1 守卫（AUTO_COMPRESS=false 跳过 LLM）
  if (!isAutoCompressEnabled()) {
    return { success: false, skipped: true, reason: "auto-compress disabled" };
  }

  // 计算 hasImage（必须从 raw 读取，spec 当前未展示）
  const hasImage = raw.modality === "image" || raw.modality === "mixed";

  // LLM 调用（与现状相同）
  const response = await provider.compress(buildCompressionPrompt(raw));

  // 解析 + 评分（与现状相同）
  const parsed = parseCompressionXml(response);
  if (!parsed) return { success: false, error: "parse_failed" };
  const qualityScore = scoreCompression(parsed);

  // 构造 compressed 对象（用 raw 替换 data.raw）
  const compressed: CompressedObservation = {
    id: data.observationId,
    sessionId: data.sessionId,
    timestamp: raw.timestamp,
    ...parsed,
    confidence: qualityScore / 100,
    ...(hasImage ? { modality: raw.modality } : {}),
    ...(imageDescription ? { imageDescription } : {}),
    ...(raw.imageData ? { imageRef: raw.imageData } : {}),
    ...(raw.agentId ? { agentId: raw.agentId } : {}),
    compressionKind: "llm",
    compressionVersion: 1,
  };

  await kv.set(KV.observations(data.sessionId), data.observationId, compressed);

  // search index / vector index / stream（与现状相同）
}
```

---

## 🟡 SCOPE-4 · P1-3 graph-extract 重复处理的 trade-off 值得再论证

**位置**：spec 处理状态 line 320

### 问题

spec line 320 把"依赖 `max_retries: 3` 引擎层去重；接受最多 3 次 LLM 调用 / observation"作为已知 trade-off。但 `max_retries` 是**重试**次数（调用失败时），不是去重（重复入队时）。

**真正的问题**：P1-3 评审指出的是"session::stopped 重试时同一批 observation 被 graph-extract 反复处理"。新 spec 变更 5 把 payload 从 `observations: compressed` 改为 `observationIds: compressed.map(o => o.id)` —— graph-extract drain 时按 ID 重读。这意味着每次重试都**重读同一批 observation 并重新生成 graph nodes**，可能导致重复节点（取决于 mem::graph-extract 的去重逻辑）。

### 修复

spec 应明确 mem::graph-extract 内部如何去重，或在 spec 验收 AC5 中加一条：

```text
AC5a: POST /agentmemory/graph/build → graph 节点 > 0
AC5b: 重发 POST /agentmemory/graph/build（同 session）→ graph 节点数不增长（去重验证）
```

或在 spec 实施 P5 之前，先读 `src/functions/graph.ts` 确认去重逻辑（如果不存在则需补）。

---

## 修复优先级

| 顺序 | 项 | 阻塞 |
|------|-----|------|
| 1 | P0-7 / P1-5（spec 变更 3 函数体补全） | 编译失败 / npm test 不可达 |
| 2 | P2-5（filter 兼容旧数据） | AC9 失败（live ≠ backfill） |
| 3 | P1-4（AC3 / AC9 环境前置标注） | 验收步骤误导 |
| 4 | SCOPE-4（mem::graph-extract 去重验证） | AC5b 可能失败 |

---

## 验证方法（实施后 dry-run）

1. **签名兼容性**：跑 `npm run build`，确认无 TS 错误；跑 `npx vitest run test/compress.test.ts`，确认旧测试通过或更新测试 fixture
2. **旧数据兼容**：从 KV 读一条旧 backfill observation（无 compressionKind 字段），POST /agentmemory/graph/build，验证它进入 graph-extract 处理
3. **环境前置文档化**：在 README 或 AGENTS.md 加一段说明 AUTO_COMPRESS=true 是哪些 AC 的前置
4. **graph-extract 去重**：连续两次 POST /agentmemory/graph/build（同 session），比较节点数

---

## 战略债务（不在本次修复范围）

- **SCOPE-1**（16 处 Void 只修 2 处）：仍待立项
- **SCOPE-2**（refine 是永久负担）：变更 8 部分缓解，但 refine-backfill.py 仍是历史 catch-up 的一次性脚本，建议运行后归档
- **数据迁移**：21K 旧 observation 无 compressionKind 字段，需要一次性迁移脚本（或在 refine phase 2 入队时自动标记）