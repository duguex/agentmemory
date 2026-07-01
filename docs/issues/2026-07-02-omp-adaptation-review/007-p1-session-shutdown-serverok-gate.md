# [P1-007] `session_shutdown` 受 `!serverOk` gate 影响,中途崩溃后丢失关闭事件

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:211-214
**类别**:cross-file(运行时序)

## 问题

```ts
pi.on("session_shutdown", async () => {
  if (!serverOk) return;   // ← gate
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

`serverOk` 在第 87 行初始化为 `false`,仅在 `session_start` handler 做完 health 探测后才置 true。中间没有任何重探逻辑。

## 影响

- **场景 A**:启动时服务端可达 → session 创建为 `active`,serverOk=true,关闭正常
- **场景 B**:启动时服务端不可达 → serverOk 永远为 false → `session_shutdown` 静默 return → 但 session 行从未被创建,符合预期(但用户体验差:用户以为在记录,实际没有)
- **场景 C**:启动时可达,中途服务端崩溃 → serverOk 仍为 stale-true,POST 在网络层失败,被 `void apiPost` 静默吞掉 → `event::session::stopped` 永不触发 → summarize/slot-reflect/lesson-decay/graph-extract 永不运行

## 触发场景

```bash
# Terminal 1
AGENTMEMORY_URL=http://localhost:3111 omp
# session 创建成功,serverOk=true

# Terminal 2
pkill -9 node  # 杀掉 agentmemory 服务端
# 再启动
AGENTMEMORY_URL=http://localhost:3111 agentmemory

# Terminal 1
# Ctrl+D 退出 omp
# session_shutdown 触发,但 POST 失败,session 行永远停在 active
```

## 修复

**方案 A(推荐)**:去掉 gate,改用 fire-and-forget 让 POST 自己失败:

```ts
pi.on("session_shutdown", async () => {
  // 不论 serverOk,都尝试发送——失败由 void apiPost 吞掉
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

**方案 B**:在 shutdown 前重探一次 health:

```ts
pi.on("session_shutdown", async () => {
  const health = await apiGet("health");
  if (!health) return;
  void apiPost("session/end", { sessionId, reason: "shutdown" });
});
```

方案 A 更简单,且对于"进程崩溃前最后的挣扎"语义更合理。

## 相关位置

- `integrations/omp/index.ts:87`(`serverOk` 初始化)
- `integrations/omp/index.ts:150-158`(`session_start` 中 serverOk 设置)