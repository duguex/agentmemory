# [P0-028] `_cleanupTimers` 数组收集后从不消费——shutdown 不调用 `clearInterval`,且新定时器缺 `.unref()`

**严重度**:🔴 P0
**文件**:`src/index.ts:264, 268, 276, 601-612`
**类别**:line-by-line + altitude(P0-002 的 altitude 升级版)

## 问题

### P0-002 的范围

P0-002 已记录新 setInterval 缺 `.unref()` 的事实。本条 issue 进一步指出 **`_cleanupTimers` 数组根本没用**——

```ts
// 第 264 行
const _cleanupTimers: ReturnType<typeof setInterval>[] = [];

// 第 268, 276 行
_cleanupTimers.push(setInterval(() => {...}, autoForgetMs));
_cleanupTimers.push(setInterval(() => {...}, evictMs));

// 第 601-612 行 shutdown handler
const shutdown = async () => {
  console.log(`\n[agentmemory] Shutting down...`);
  healthMonitor.stop();
  dedupMap.stop();
  indexPersistence.stop();
  await new Promise<void>((resolve) => viewerServer.close(() => resolve()));
  await indexPersistence.save().catch((err) => {...});
  await sdk.shutdown();
  clearWorkerPidfile();
  process.exit(0);
  // ← 缺少 for (const t of _cleanupTimers) clearInterval(t);
};
```

`_cleanupTimers` 数组被推入 2 个 timer handle,但 `shutdown` handler **从未遍历该数组**。

### 三层失效叠加

1. **未 `.unref()`**:新定时器持有事件循环
2. **未 `clearInterval`**:shutdown 后定时器继续运行
3. **shutdown 后 sdk 已 shutdown**:定时器继续触发 `sdk.trigger({function_id: "mem::auto-forget"...})`,sdk 已经 shutdown,trigger 必然失败或抛错(被 `.catch(() => {})` 吞掉)

## 影响

- 进程在 SIGINT/SIGTERM 后无法干净退出——`process.exit(0)` 被未清理的定时器抢先
- 长期运行后,定时器在已 shutdown 的 sdk 上反复触发,日志中可能有重复 trigger 错误(被 catch 吞掉)
- 变量名 `_cleanupTimers` 暗示清理但从不清理——误导未来维护者
- 测试场景:`await main()` 之后调用 `process.exit()` 无限挂起,CI 超时

## 与已有 P0-002、P0-003 的关系

- P0-002:未 `.unref()` → 进程不退
- P0-003:定时器重复 → 资源浪费 + 数据竞态
- **P0-028(本条)**:shutdown 不清理 → 即使 `.unref()` 添加后,shutdown 路径仍依赖 `.unref()` 的间接清理,不显式

三个 bug 一起修复才完整。

## 修复

**方案 A(最小修复)**:在 shutdown handler 中显式清理:

```ts
const shutdown = async () => {
  console.log(`\n[agentmemory] Shutting down...`);

  // 清理 _cleanupTimers 数组
  for (const t of _cleanupTimers) clearInterval(t);
  _cleanupTimers.length = 0;

  healthMonitor.stop();
  // ...
};
```

**方案 B(彻底)**:删除 `_cleanupTimers` 数组,改为在每处 setInterval 后立即 `.unref()`:

```ts
const autoForgetMs = getAutoForgetIntervalMs();
if (autoForgetMs > 0) {
  const timer = setInterval(() => {
    sdk.trigger({
      function_id: "mem::auto-forget",
      payload: { dryRun: false },
      action: TriggerAction.Void(),
    }).catch(() => {});
  }, autoForgetMs);
  timer.unref();  // ← 立即 unref
  bootLog(`Auto-forget: scheduled every ${autoForgetMs}ms`);
}
```

**方案 C(altitude 修复)**:提取 `scheduleCleanup(sdk, fnId, payload, ms)` helper:

```ts
function scheduleCleanup(
  sdk: SDK,
  functionId: string,
  payload: Record<string, unknown>,
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    sdk.trigger({
      function_id: functionId,
      payload,
      action: TriggerAction.Void(),
    }).catch(() => {});
  }, intervalMs);
  timer.unref();
  return timer;
}

// 使用
const timers: NodeJS.Timeout[] = [];
if (autoForgetMs > 0) {
  timers.push(scheduleCleanup(sdk, "mem::auto-forget", { dryRun: false }, autoForgetMs));
}

// shutdown
for (const t of timers) clearInterval(t);
```

并替换 src/index.ts 中所有 5+ 个现有 setInterval 为 `scheduleCleanup` 调用。

## 触发场景

1. 启动 agentmemory,设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=30000`
2. 工作一段时间后 Ctrl+C
3. 看到 `[agentmemory] Shutting down...`
4. 期望:进程立即退出
5. 实际:进程挂起,定时器每 30 秒触发一次(虽然 sdk 已 shutdown,但事件循环不退出)
6. 用户只能 SIGKILL

## 验证步骤

1. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=5000`
2. 启动 agentmemory,工作 10 秒
3. Ctrl+C
4. 期望:进程在 1 秒内退出,exit code = 0
5. 修复前:进程挂起,5 秒后才退出(或 SIGKILL)
6. 修复后:进程立即退出

**这是 P0-002 的 altitude 升级——不只补 `.unref()`,还要让 shutdown 路径显式清理**。
