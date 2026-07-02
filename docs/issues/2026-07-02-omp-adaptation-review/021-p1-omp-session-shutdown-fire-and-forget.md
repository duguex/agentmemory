# [P1-021] OMP `session_shutdown` 使用 `void apiPost`,POST 可能未完成进程已退出——会话永不结束

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:231-233`
**类别**:line-by-line(资源/状态泄漏)

## 问题

```ts
pi.on("session_shutdown", async () => {
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

`void` 运算符丢弃 promise,handler 立即返回,但 `apiPost` 内部的 `await fetch(...)` 可能仍在进行中。

## 影响

- 用户退出 OMP
- `session_shutdown` handler 触发,**立即返回**(不等待 fetch)
- OMP 在 handler resolve 后拆解进程
- 进程退出时 `fetch` 可能仍处于 DNS/TCP/TLS 握手阶段,或正在发送 body
- 服务器从未收到 `session/end`,会话停留在 `active` 状态
- 后果:
  - `agentmemory` 仪表盘的"活跃会话数"虚高
  - 自动 forget/evict 基于 `lastActivityAt` 的会话老化逻辑无法清理这些孤儿会话
  - 计费/用量统计错误
  - `kv.list(KV.sessions)` 中累积大量永远 `active` 的记录

## 与已有 P1-007 的关系

[P1-007](./007-p1-session-shutdown-serverok-gate.md) 指出 `session_shutdown` 受 `!serverOk` gate 影响可能跳过——本条是相反方向的 bug:即使 `serverOk=true`,handler 也不等待 POST 完成。

两个 bug 都导致会话结束事件丢失,但触发条件不同(007:条件跳过;021:异步丢失)。

## 修复

要么:

**方案 A**:在 handler 中 await:

```ts
pi.on("session_shutdown", async () => {
  await apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

但 OMP 可能在 handler 返回后才退出,所以仅 await 不够保险。

**方案 B(推荐)**:通过信号机制让 OMP 等待:

```ts
pi.on("session_shutdown", async () => {
  // 同步尝试 fetch(fetch + AbortSignal.timeout 可设置超时)
  // 或者,使用 lifecycle 钩子提供的 done 回调
});
```

实际修复依赖 OMP 的生命周期 API 是否允许 handler 阻塞 shutdown。需查阅 `@oh-my-pi/pi-coding-agent` 文档。

**方案 C**:在进程级拦截 SIGINT/SIGTERM,优先 flush 未完成的 observe:

```ts
process.on("beforeExit", async () => {
  await apiPost("session/end", { sessionId, reason: "exit" });
});
```

## 验证步骤

1. 启动 OMP 会话
2. 检查服务器 KV:`session/start` 已记录,session 状态 = `active`
3. 退出 OMP(`exit` 或 Ctrl+C)
4. 等待 2 秒后查询:`session/end` 应已记录
5. 修复前:`session/end` 缺失,session 永远 `active`
6. 修复后:`session/end` 记录完整,session 状态变为 `closed`

**这是与 P1-007(serverOk gate)互补的会话结束丢失问题**。
