# Code Review — feat/omp-adaptation (2026-07-01)

**审查范围**:`git diff HEAD` 在 `plugin/scripts/*.mjs`、`src/config.ts`、`src/index.ts` 中的改动,以及新增的 `integrations/omp/` 目录(未跟踪)。

**审查方法**:7 个独立角度(line-by-line / removed-behavior / cross-file / reuse / simplification / efficiency / altitude)× 各 6 候选 → 去重后对 8 条候选做 1-vote 验证(recall-biased)。

**结论**:8 条 candidate 全部 CONFIRMED,均为功能性 bug(无 style-only 项)。按严重度排序。

---

## 严重度图例

- 🔴 **P0** — 生产环境功能静默失效,无任何错误提示
- 🟠 **P1** — 数据正确性 / 一致性损坏
- 🟡 **P2** — 资源泄露 / 行为偏离

---

## 🔴 P0-1 · 删除了两个条件注册块,功能静默失效

**文件**:`src/index.ts` (旧 261-272 行)
**类别**:removed-behavior

### 问题

diff 删除了两个条件注册块:

```ts
// 旧代码(已被删除)
const claudeBridgeConfig = loadClaudeBridgeConfig();
if (claudeBridgeConfig.enabled) {
  registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
  bootLog(`Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`);
}

if (isGraphExtractionEnabled()) {
  registerGraphFunction(sdk, kv, provider);
  bootLog(`Knowledge graph: extraction enabled`);
}
```

`registerClaudeBridgeFunction` 和 `registerGraphFunction` 的 import 在第 60-61 行保留,但仅剩的调用点都在 `test/` 里。

### 影响

- 设置 `GRAPH_EXTRACTION_ENABLED=true` 时,会话结束触发 `mem::graph-extract`,但 handler 未注册,SDK 静默 no-op
- 设置 `CLAUDE_MEMORY_BRIDGE=true` 时,`src/triggers/api.ts:1378` 和 `:1399` 调用 `mem::claude-bridge-read` / `mem::claude-bridge-sync`,但 handler 未注册
- 测试能通过是因为它们直接调用注册函数
- 同时 `claudeBridgeConfig` 变成 dead variable(第 288 行)

### 修复

```ts
// 恢复两个条件注册块
const claudeBridgeConfig = loadClaudeBridgeConfig();
if (claudeBridgeConfig.enabled) {
  registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
  bootLog(`Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`);
}

if (isGraphExtractionEnabled()) {
  registerGraphFunction(sdk, kv, provider);
  bootLog(`Knowledge graph: extraction enabled`);
}
```

---

## 🔴 P0-2 · `action: "void"` 是裸字符串,违反 iii-sdk 类型契约

**文件**:`src/index.ts` 第 271、283 行
**类别**:cross-file(SDK 类型契约)

### 问题

```ts
sdk.trigger({
  function_id: "mem::auto-forget",
  payload: { dryRun: false },
  action: "void",   // ← 错误:应是 TriggerAction.Void()
});
```

`iii-sdk` 的 `TriggerAction` 是判别联合类型(`node_modules/iii-sdk/dist/utils-Cx5sef26.d.mts:128-133`):

```ts
type TriggerAction = { type: 'enqueue'; queue: string; } | { type: 'void'; };
```

运行时检查 `action?.type === "void"`(`index.mjs:363`);裸字符串没有 `.type` 字段,落到同步分支,`sdk.trigger` 会等待函数结果。

### 影响

- 两个新定时器在每个 tick 阻塞等待 `mem::auto-forget` / `mem::evict` 完成——违背 fire-and-forget 本意
- TypeScript 应该拒绝 `"void"`;如果没拒绝,说明构建没对 `src/index.ts` 做类型检查
- `.catch(() => {})` 吞掉的是 Promise rejection,不是阻塞等待

### 修复

```ts
import { TriggerAction } from "iii-sdk";

sdk.trigger({
  function_id: "mem::auto-forget",
  payload: { dryRun: false },
  action: TriggerAction.Void(),   // ← 正确写法
}).catch(() => {});
```

代码库里其他 10+ 处 fire-and-forget 调用都使用 `TriggerAction.Void()`(observe.ts、events.ts、api.ts 等),照抄即可。

---

## 🟠 P1-1 · OMP 集成对同事件发送重复 POST

**文件**:`integrations/omp/index.ts` 第 178-195、221-234、287-299、323-341 行
**类别**:cross-file(OMP 事件语义)

### 问题

OMP 运行时对同一条助手消息会同时触发 `message_end` 和 `turn_end`,对同一次工具执行会同时触发 `tool_result` 和 `tool_execution_end`。两个 handler 都 POST `observe` 且 payload 重叠。

附加 bug:`tool_result` handler 读 `event.result`,但 OMP 的 ToolResultEvent 实际字段是 `content`/`details`——所以 `tool_result` 这一路 POST 出去的 `tool_output` 实际上是空串,只有 `tool_execution_end` 发出真实内容。

### 影响

- 每条助手消息:2 次 POST(notification + post_tool_use)
- 每次工具执行:2 次 POST
- 网络流量、observation 表行数、BM25 索引开销全部翻倍
- 部分 POST 内容为空(tool_result 路径),污染索引

### 修复

去掉重复 handler,只保留覆盖面更广的那一对:

```ts
// 删除 message_end handler(与 turn_end 重复)
// 删除 tool_result handler(与 tool_execution_end 重复,且字段名错误)
```

或者只保留一对 + 改名(让 hookType 更准确,例如把 `turn_end` 的 `post_tool_use` 改成 `notification`)。需要决策后再做。

---

## 🟠 P1-2 · `tool_result` 失败分支漏发 `tool_input`

**文件**:`integrations/omp/index.ts` 第 178-195 行
**类别**:cross-file(服务端契约)

### 问题

```ts
// 失败分支发的 data 缺少 tool_input
data: {
  tool_name: toolName,
  tool_output: truncate(toolResult, 2000),
  error: isError ? true : undefined,
}
```

服务端 `src/functions/observe.ts:102-109` 对 `post_tool_use` 和 `post_tool_failure` 都读取 `d["tool_input"]`:

```ts
if (payload.hookType === "post_tool_use" || payload.hookType === "post_tool_failure") {
  raw.toolName = d["tool_name"] as string | undefined;
  raw.toolInput = d["tool_input"];
  raw.toolOutput = d["tool_output"] || d["error"];
}
```

`dedupMap.computeHash` 也以 `tool_input` 为 key。

### 影响

- 失败观察以 `toolInput: undefined` 保存,无法与原始输入关联
- 失败事件去重 hash 与成功事件键不同 → 去重假阴性
- 与 `tool_execution_start`(第 273-285 行,确实发 `tool_input`)不一致

### 修复

从 `tool_execution_start` 已发的 `tool_input` 缓存,或在 `tool_execution_start` 里把 input 暂存,在 `tool_result` 里读出再发:

```ts
// 简单方案:在 tool_result handler 里加 tool_input,即使它可能为空也要发键
data: {
  tool_name: toolName,
  tool_input: toolInput,   // 即使 "" 也要发,服务端才能 set undefined-or-empty
  tool_output: truncate(toolResult, 2000),
  error: isError ? true : undefined,
}
```

(更好的方案是用 module-scope Map 把 start/end 配对,但需要单独讨论。)

---

## 🟠 P1-3 · `session_end` 触发两次,服务端非幂等

**文件**:`integrations/omp/index.ts` 第 266-269、345-348 行
**类别**:cross-file(服务端 API 语义)

### 问题

```ts
pi.on("session_shutdown", async () => {
  if (!serverOk) return;
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});

pi.on("agent_end", async () => {
  if (!serverOk) return;
  void apiPost("session/end", { sessionId });
});
```

OMP 关闭时两个事件都会触发。服务端 `src/triggers/api.ts:617-644`:

```ts
await kv.update(KV.sessions, sessionId, [
  { type: "set", path: "endedAt", value: new Date().toISOString() },
  { type: "set", path: "status", value: "completed" },
]);
sdk.trigger({ function_id: "event::session::stopped", ... });
```

无条件覆盖 `endedAt` / `status`,无条件扇出 `event::session::stopped`。

### 影响

- `endedAt` 被第二次调用覆盖为更晚的时间戳
- `status` 可能覆盖中途已转 `'aborted'` / `'failed'` 的状态
- `event::session::stopped` 触发两次,导致同会话的 summarize、slot-reflect、graph-extract 各跑两遍(整合、lesson-decay、审计日志全重复)

### 修复

二选一:

**客户端方案**:在 omp 集成里去掉 `agent_end` 的 session/end 调用(OMP 的 `session_shutdown` 是更明确的关闭信号):

```ts
// 删除 agent_end handler 中的 apiPost("session/end", ...)
```

**服务端方案**:在 `api::session::end` handler 加幂等检查:

```ts
const existing = await kv.get(KV.sessions, sessionId);
if (existing?.endedAt) return { status_code: 200, body: { success: true, idempotent: true } };
```

客户端方案更轻,推荐。

---

## 🟡 P2-1 · 新 setInterval 缺少 `.unref()`,进程无法干净退出

**文件**:`src/index.ts` 第 267、279 行
**类别**:line-by-line(对老惯例的偏离)

### 问题

新定时器:

```ts
setInterval(() => {
  sdk.trigger({...}).catch(() => {});
}, autoForgetInterval);
// 没有 .unref(),也没有保存句柄
```

同文件其他 5 个 setInterval 都遵循统一模式(第 561、571、581、596、604 行):

```ts
const autoForgetTimer = setInterval(async () => {...}, ms);
autoForgetTimer.unref();
```

### 影响

- 长跑 agentmemory 进程在所有工作完成后仍被新 interval 持有事件循环,无法退出
- 期望 `main()` 结束后退出的测试和 CLI 调用会无限挂起
- 第 608 行的 `shutdown()` handler 无法清理这些 handle(因为没保存)

### 修复

```ts
const autoForgetTimer = setInterval(() => {
  sdk.trigger({
    function_id: "mem::auto-forget",
    payload: { dryRun: false },
    action: TriggerAction.Void(),
  }).catch(() => {});
}, autoForgetInterval);
autoForgetTimer.unref();

// 同理改 evict timer
const evictTimer = setInterval(() => {
  sdk.trigger({
    function_id: "mem::evict",
    payload: {},
    action: TriggerAction.Void(),
  }).catch(() => {});
}, evictInterval);
evictTimer.unref();
```

更彻底:提取 `scheduleInterval(sdk, functionId, payload, ms)` helper,统一 7 处定时器。

---

## 🟡 P2-2 · 重复 auto-forget 调度

**文件**:`src/index.ts` 第 263-273、555-563 行
**类别**:line-by-line(双轨并行)

### 问题

新代码加了一个 `mem::auto-forget` 的 setInterval(由 `AGENTMEMORY_AUTO_FORGET_INTERVAL` 控制,默认 0 / 关闭);旧代码也保留了同样的 setInterval(由 `AUTO_FORGET_INTERVAL_MS` 控制,默认 3600000ms)。当用户设置新环境变量时,两条调度并行运行。

### 影响

- 用户设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=30000`:新定时器每 30 秒触发,旧定时器仍按 1 小时默认触发
- `mem::auto-forget` 在两条调度上各跑一遍,扫描/淘汰开销翻倍
- mem::auto-forget 改状态(删除记忆、递减 image 引用、写审计日志);并发调用可能重复删除同一行(TTL 已过期的行被删两次)

### 修复

二选一:

**方案 A(推荐)**:删除新代码,统一用旧的:

```ts
// 删除 src/index.ts 第 263-274 行整块
// 旧的 AUTO_FORGET_INTERVAL_MS 默认 3600000ms 已经够用
```

**方案 B**:把旧代码迁到新环境变量名,统一入口:

```ts
// 旧的 setInterval 块删掉
// 新块保留,把 AUTO_FORGET_INTERVAL_MS 改成 AGENTMEMORY_AUTO_FORGET_INTERVAL
```

注意:这与 [P2-1](#-p2-1--新-setinterval-缺少-unref进程无法干净退出) 是同一段代码,合并修复即可。

---

## 🟡 P2-3 · `session_shutdown` 受 `!serverOk` gate 影响,可能丢失会话结束事件

**文件**:`integrations/omp/index.ts` 第 266-269 行
**类别**:cross-file(运行时序)

### 问题

```ts
pi.on("session_shutdown", async () => {
  if (!serverOk) return;   // ← gate
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

`serverOk` 在第 87 行初始化为 `false`,仅在 `session_start` handler 做完 health 探测后才置 true。中间没有任何重探逻辑。

### 影响

- 启动时服务端可达 → session 创建为 `active`、serverOk=true
- 中途服务端崩溃并被重启到同一端口 → serverOk 仍为 stale-true,POST 在网络层失败,被 `void apiPost` 静默吞掉
- 会话行永远停在 `active`,`event::session::stopped`(驱动 summarize、slot-reflect、lesson-decay、graph-extract)永不触发

(候选 agent 原始 framing 是"启动时服务端不可达 → 没有 active 行"——这不准确,因为此时本来就没创建行。**真正的 bug 是"中途崩溃 + 重启 + 没有 health 重探"这个场景**,上面已修正。)

### 修复

去掉 gate,改用 fire-and-forget 让 POST 自己失败:

```ts
pi.on("session_shutdown", async () => {
  // 不论 serverOk,都尝试发送——失败由 void apiPost 吞掉
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

或者在 session_shutdown 之前重探一次 health:

```ts
pi.on("session_shutdown", async () => {
  const health = await apiGet("health");
  if (!health) return;
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

第一种更简单,推荐。

---

## 附录 A · 未进入 top 8 但仍建议处理的清理项

- `src/config.ts` 第 156-166 行:`getAutoForgetIntervalMs` / `getEvictIntervalMs` 是字符级相同的复制粘贴,改用现有 `safeParseInt(val, 0)` 一行解决,并和 `getFollowupWindowSeconds` 等保持一致风格
- `src/index.ts` 第 263-286 行两个新 setInterval 块与第 555-606 行的 5 个老块同形,可提取 `scheduleInterval(sdk, functionId, payload, ms)` helper 统一管理(同时解决 P2-1 / P2-2)
- `integrations/omp/index.ts` 第 27-32 行 `authHeaders` 无条件加 `Content-Type: application/json`,会传染到 GET 请求(无害但不规范);GET 应只发 `Authorization`
- `integrations/omp/index.ts` 第 34-61 行 `apiPost` / `apiGet` 重复 URL 拼接 + try/catch + response.ok + .json() 模式,可合并为 `apiFetch<T>(method, path, body?)`
- `integrations/omp/index.ts` 第 63-65 行 `truncate(s, max)` 当 `max <= 0` 时返回字面量 `"..."`(应该返回 `""`)
- `plugin/scripts/*.mjs` 是 `tsdown` 从 `src/hooks/*.ts` 生成的构建产物(`tsdown.config.ts:80-86`),手编 diff 没意义,会被 `npm run build` 覆盖——检查 git status 时排除这 13 个文件,或确认 source map 是否仍同步

## 附录 B · 审查方法学

- **Phase 0**:`git diff HEAD`(无上游差异)+ `git diff HEAD --stat` + `ls integrations/omp/`
- **Phase 1**:7 个独立 finder angle(Agent 工具),每 angle ≤ 6 候选 → 共 ~40 候选
- **Phase 2**:去重 → 8 条候选 → 8 个 verifier(并行),全部 CONFIRMED
- **输出**:JSON array ≤ 10 条,按 P0 > P1 > P2 排序

审查结果已交付为 JSON array(8 条),本文档为带修复建议的扩展版。