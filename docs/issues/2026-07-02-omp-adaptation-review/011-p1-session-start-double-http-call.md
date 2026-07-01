# [P1-011] `session_start` 双重 HTTP 调用且 `serverOk` 被冗余覆写

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:150-158
**类别**:line-by-line(冗余 + 状态错乱)

## 问题

```ts
pi.on("session_start", async () => {
  sessionId = `auto-${Date.now().toString(36)}`;
  currentProject = process.cwd();
  sessionInjected = false;
  const result = await apiPost("session/start", { sessionId, project: currentProject, cwd: currentProject });
  serverOk = result !== null;          // ← 第 1 次设置
  const health = await apiGet("health");
  serverOk = health !== null;           // ← 第 2 次设置,完全覆盖
});
```

两个问题:
1. 两次串行 HTTP 调用,启动延迟 × 2
2. 第二次调用完全覆盖第一次的结果

## 影响

如果 `session/start` 成功但 `health` 因瞬时 blip 失败,`serverOk` 被设为 false——session 已创建但所有 observe hook 都因 `!serverOk` gate(见 [issue 007](./007-p1-session-shutdown-serverok-gate.md)) 而静默退出,直到用户手动调用 `agentmemory_status` tool 重试。

`agentmemory_status` tool(第 91-104 行)确实会重新设置 `serverOk`,但普通用户不会主动调用它,导致整个 OMP session 的所有 observe 事件被吞掉,session 行永远停在 `active`。

## 触发场景

```ts
// 启动 OMP,session 创建成功(网络正常)
// 第 1 次 POST: 200 OK → serverOk = true
// 第 2 次 GET /health: 服务端 GC pause 超过 5s,fetch 超时 → 返回 null → serverOk = false
// 后续 turn_start/turn_end/tool_execution_* 全部因 !serverOk 静默退出
// session 行只有 metadata,没有 observations
```

## 修复

```ts
pi.on("session_start", async () => {
  sessionId = `auto-${Date.now().toString(36)}`;
  currentProject = process.cwd();
  sessionInjected = false;
  const result = await apiPost("session/start", { sessionId, project: currentProject, cwd: currentProject });
  serverOk = result !== null;   // 只信 session/start 的成功
});
```

如果想保留 health 探测(用于 boot 时 UI 提示),应该在 `serverOk` 之上加一个独立的 `lastHealthOk` 标志,不要用 health 覆写 `serverOk`。

## 相关位置

- `integrations/omp/index.ts:91-104`(`agentmemory_status` tool,目前是唯一的 serverOk 重置入口)