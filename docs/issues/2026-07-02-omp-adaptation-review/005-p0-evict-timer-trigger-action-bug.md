# [P0-005] evict 定时器同样使用裸字符串 `action: "void"`

**严重度**:🔴 P0
**文件**:`src/index.ts`
**行**:277
**类别**:cross-file(SDK 类型契约)

## 问题

```ts
sdk.trigger({ function_id: "mem::evict", payload: {}, action: "void" })
```

与 [issue 001](./001-p0-trigger-action-void-string.md) 完全相同的 bug,但出现在 evict 定时器上。

iii-sdk 的 `TriggerAction` 是判别联合类型,裸字符串没有 `.type` 字段,落到同步分支,`sdk.trigger` 会阻塞等待函数结果。

## 影响

`mem::evict` 在大语料库上的扫描可能耗时数秒(逐条检查 TTL、引用计数、跨 session 关联),每个 tick 阻塞事件循环。`src/functions/evict.ts:96` 注册的 evict handler 内部有 170-332 行多处 `await recordAudit`,每次记录审计日志都阻塞。

## 触发场景

`AGENTMEMORY_EVICT_INTERVAL=60000` + 大语料库(10k+ observations)→ 每 60 秒冻结事件循环数秒

## 修复

```ts
import { TriggerAction } from "iii-sdk";
// ...
action: TriggerAction.Void()
```

应与 [issue 001](./001-p0-trigger-action-void-string.md) 合并修复:提取 `scheduleInterval(sdk, functionId, payload, ms)` helper,统一使用 `TriggerAction.Void()`。