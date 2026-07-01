# [P0-001] 裸字符串 `action: "void"` 违反 iii-sdk `TriggerAction` 判别联合

**严重度**:🔴 P0
**文件**:`src/index.ts`
**行**:269
**类别**:cross-file(SDK 类型契约)

## 问题

```ts
sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: "void" })
```

iii-sdk 的 `TriggerAction` 是判别联合类型(`node_modules/iii-sdk/dist/utils-Cx5sef26.d.mts:128-133`):

```ts
type TriggerAction = { type: 'enqueue'; queue: string; } | { type: 'void'; }
```

运行时检查 `action?.type === "void"`;裸字符串没有 `.type` 字段,落到同步分支,`sdk.trigger` 会阻塞等待函数结果。

## 影响

两个新定时器在每个 tick 阻塞等待 `mem::auto-forget` / `mem::evict` 完成——违背 fire-and-forget 本意。`.catch(() => {})` 吞掉的是 Promise rejection,不是阻塞等待。代码库其他 10+ 处 fire-and-forget 调用都使用 `TriggerAction.Void()`。

## 触发场景

`AGENTMEMORY_AUTO_FORGET_INTERVAL=30000` → 每 30 秒阻塞一次事件循环,阻塞时长 = 一次完整 auto-forget 扫描时长。在大语料库(数千条 observation)上扫描可能耗时 5+ 秒,事件循环冻结。

## 修复

```ts
import { TriggerAction } from "iii-sdk";
// ...
action: TriggerAction.Void()
```

## 验证步骤

1. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=10000`
2. 用一个包含 1000+ observation 的 KV 启动 agentmemory
3. 在另一个 shell 跑 `while true; do date; sleep 0.1; done`,观察间隔是否 >1 秒
4. 修复后应该保持 ~100ms 间隔

## 相关位置

- `src/index.ts:269`(auto-forget timer)
- `src/index.ts:277`(evict timer,相同 bug,见 issue 005)