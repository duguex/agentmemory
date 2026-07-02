# [P1-020] OMP `agent_end` 是空操作,丢掉每个子 agent 的完成信号——与 `agent_start` 形成非对称生命周期

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:114, 315-317`
**类别**:removed-behavior(对比 Claude `subagent-stop.mjs`)

## 问题

```ts
pi.on("agent_end", async () => {
  // no-op: session/end is sent by session_shutdown
});
```

`agent_end` 被注册但不做任何事,注释声称 `session/end is sent by session_shutdown`。

但 `agent_end` 在 OMP/Pi 中的语义是**每个 agent 完成后触发一次**——主 agent 完成、子 agent 完成都会触发。Claude 插件通过 `plugin/scripts/subagent-stop.mjs` 捕获该信号。

## 影响

- 派生 N 个子 agent → `agent_start` 触发 N 次(并被 P1-019 错误归类为主 agent 算 1 次,真实子 agent 算 N 次,但每次都被错标为 `subagent_start`)
- `agent_end` 触发 N 次(每个子 agent 完成)→ 0 个 `subagent_stop` 观察入库
- 服务器端:
  - `subagent_start` 观察变成"孤儿"——没有对应的 `subagent_stop` 配对
  - 子 agent 时长分析只有开始一半
  - 以 `event::subagent::stopped` 为键的下游触发器(`mem::graph-extract` 批边界、`mem::slots::reflect`、`mem::actions`)在 OMP 子 agent 上永不触发
- 与 Claude 插件对比:Claude 有 `SubagentStart` + `SubagentStop` 对称配对;OMP 只有 `agent_start`(错标)+ 完全空操作的 `agent_end`

## 触发场景

1. OMP 会话依次派生 3 个子 agent
2. `agent_start` 触发 3 次 → 3 个 `subagent_start` 观察入库
3. 第 1 个子 agent 完成,`agent_end` 触发 → 空操作
4. 第 2 个子 agent 完成,`agent_end` 触发 → 空操作
5. 第 3 个子 agent 完成,`agent_end` 触发 → 空操作
6. 服务器端只有 3 个 `subagent_start`,0 个 `subagent_stop`
7. 子 agent 仪表盘显示 3 个永远"运行中"的子 agent
8. 时长统计、计费、graph-extract 批边界全部错误

## 修复

实现 `agent_end` 处理器,匹配 `agent_start` 的语义:

```ts
pi.on("agent_end", async (event: unknown) => {
  if (!serverOk) return;
  const agentId = event && typeof event === "object" && "agentId" in event
    ? String((event as any).agentId)
    : undefined;
  void apiPost("observe", {
    hookType: "subagent_stop",
    sessionId,
    project: currentProject,
    cwd: currentProject,
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "subagent_stop",
      agent_id: agentId,
    },
  });
});
```

并确保 P1-019 修复后,`agent_start` 和 `agent_end` 形成对称配对。

## 验证步骤

1. OMP 会话派生 1 个子 agent
2. 子 agent 完成,触发 `agent_end`
3. 检查服务器 KV:修复前 0 个 `subagent_stop`;修复后 1 个 `subagent_stop`,与 `subagent_start` 配对
4. 子 agent 时长统计从"无穷大"(从未停止)变为实际秒数

**这是与 P1-019(agent_start 错标)互补的非对称生命周期问题**——两个 bug 一起修复才能形成完整对称。
