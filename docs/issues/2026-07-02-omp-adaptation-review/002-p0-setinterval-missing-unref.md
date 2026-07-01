# [P0-002] 新 setInterval 缺少 `.unref()`,进程无法干净退出

**严重度**:🔴 P0
**文件**:`src/index.ts`
**行**:268, 276
**类别**:line-by-line(对老惯例的偏离)

## 问题

```ts
_cleanupTimers.push(setInterval(() => {
  sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: "void" }).catch(() => {});
}, autoForgetMs));
```

没有 `.unref()`,也没有在 `shutdown()` handler 中调用 `clearInterval`。

同文件其他 5 个 setInterval 都遵循统一模式(第 553、563、573、588、597 行):

```ts
const autoForgetTimer = setInterval(async () => {...}, ms);
autoForgetTimer.unref();
```

## 影响

- 长跑 agentmemory 进程在所有工作完成后仍被新 interval 持有事件循环,无法退出
- 期望 `main()` 结束后退出的测试和 CLI 调用会无限挂起
- `shutdown()` handler(第 601 行)从未对 `_cleanupTimers` 调用 `clearInterval`,命名暗示清理但实际不清理

## 触发场景

1. CI 测试调用 `await main()` 后 `process.exit()` 被 hang 住
2. 用户在长会话后按 Ctrl+C,看到 `Shutting down...` 但进程不退出

## 修复

```ts
const autoForgetTimer = setInterval(() => {
  sdk.trigger({
    function_id: "mem::auto-forget",
    payload: { dryRun: false },
    action: TriggerAction.Void(),
  }).catch(() => {});
}, autoForgetMs);
autoForgetTimer.unref();
_cleanupTimers.push(autoForgetTimer);
```

更好的方案:提取 `scheduleInterval(sdk, functionId, payload, ms)` helper 统一管理,顺便解决 P0-003 重复调度问题。

## 相关位置

- `src/index.ts:601-612`(`shutdown()` handler,应清理 `_cleanupTimers`)
- `src/index.ts:553, 563, 573, 588, 597`(老惯例范例)