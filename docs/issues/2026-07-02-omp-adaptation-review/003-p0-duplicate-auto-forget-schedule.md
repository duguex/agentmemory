# [P0-003] 新旧 auto-forget 定时器双轨并行,重复扫描/删除

**严重度**:🔴 P0
**文件**:`src/index.ts`
**行**:263-271(新) vs 545-556(旧)
**类别**:line-by-line(双轨并行)

## 问题

新代码加了一个 `mem::auto-forget` 的 setInterval(由 `AGENTMEMORY_AUTO_FORGET_INTERVAL` 控制,默认 0 / 关闭);旧代码也保留了同样的 setInterval(由 `AUTO_FORGET_INTERVAL_MS` 控制,默认 3600000ms)。

```ts
// 新代码(第 263-271 行)
const autoForgetMs = getAutoForgetIntervalMs();
if (autoForgetMs > 0) {
  _cleanupTimers.push(setInterval(() => {
    sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false }, action: "void" }).catch(() => {});
  }, autoForgetMs));
}

// 旧代码(第 545-556 行)——仍然存在
const autoForgetIntervalMs = parseInt(process.env.AUTO_FORGET_INTERVAL_MS || "3600000", 10);
if (process.env.AUTO_FORGET_ENABLED !== "false") {
  const autoForgetTimer = setInterval(async () => {
    try { await sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false } }); } catch {}
  }, autoForgetIntervalMs);
  autoForgetTimer.unref();
}
```

## 影响

- 用户设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=30000` 时,新定时器每 30 秒触发,旧定时器仍按 1 小时默认触发
- `mem::auto-forget` 在两条调度上各跑一遍,扫描/淘汰/审计日志开销翻倍
- 并发调用可能重复删除同一行(TTL 已过期的行被删两次)
- 审计日志(`src/functions/audit.ts:28`)出现重复条目
- `AUTO_FORGET_ENABLED=false` 想关掉旧定时器但新定时器仍在运行

## 触发场景

1. 用户设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=30000`
2. 启动 agentmemory
3. 30 秒后第一次新定时器触发,1 小时后旧定时器也触发
4. `src/functions/auto-forget.ts:51,135,179` 中的 `recordAudit` 出现双倍条目

## 修复

二选一:

**方案 A(推荐)**:删除新代码块(第 263-271 行),统一用旧的:

```ts
// 删除 src/index.ts 第 263-273 行整块
// 旧的 AUTO_FORGET_INTERVAL_MS 默认 3600000ms 已经够用
```

**方案 B**:删除旧代码块,把 `AUTO_FORGET_INTERVAL_MS` 迁到新环境变量名:

```ts
// 删除第 548-556 行,把 AUTO_FORGET_INTERVAL_MS 改成 AGENTMEMORY_AUTO_FORGET_INTERVAL
```

注意:本 issue 与 [002](./002-p0-setinterval-missing-unref.md) 是同一段代码,合并修复即可。