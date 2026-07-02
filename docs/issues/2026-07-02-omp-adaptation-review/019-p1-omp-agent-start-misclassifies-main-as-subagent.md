# [P1-019] OMP `agent_start` 无条件发送 `hookType:"subagent_start"`,主 agent 被错误归类为子 agent

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:203-213`
**类别**:line-by-line(语义错误)

## 问题

```ts
pi.on("agent_start", async () => {
  if (!serverOk) return;
  void apiPost("observe", {
    hookType: "subagent_start",  // ← 硬编码
    sessionId,
    project: currentProject,
    cwd: currentProject,
    timestamp: new Date().toISOString(),
    data: { tool_name: "subagent_start" },
  });
});
```

`hookType` 硬编码为 `"subagent_start"`,没有检查 event 是否区分主 agent 和子 agent。

在 OMP/Pi 编码代理中,`agent_start` 事件**对主 agent 和派生的子 agent 都会触发**——这是 OMP/Pi 的标准模式,主 agent 入口和派生子 agent 走同一个生命周期事件。

## 影响

- 每个 OMP 会话的**第一次** `agent_start` 事件(即主 agent)是错误的
- `subagent_start` 计数虚增 1 次/会话
- 以 `subagent_start` 为边界的下游触发器(如 `mem::graph-extract` 批处理、`mem::slots::reflect`)在错误时机触发
- 子 agent 生命周期仪表盘显示主 agent 是它自己的子 agent
- 与 Claude 插件不同:Claude 用 `UserPromptSubmit` 区分主 agent 入口,`SubagentStart` 仅对真实子 agent

## 触发场景

1. OMP 会话启动
2. 主 agent 入口触发 `agent_start`,OMP 发送 `hookType:"subagent_start"`
3. 服务器存储该观察,`subagent_start` 计数器 +1
4. 用户后续工作 N 个 turn 后,实际派生子 agent,触发第二个 `agent_start`
5. 现在有 2 个 `subagent_start` 观察,但实际只有 1 个真实子 agent
6. 子 agent 数量统计、生命周期分析、时间线重建全部错误

## 修复

OMP/Pi 的 `agent_start` 事件通常包含一个 `agentRole` 或 `agentType` 字段(具体字段名依 OMP 版本而定)。需区分主 agent 与子 agent:

```ts
pi.on("agent_start", async (event: unknown) => {
  if (!serverOk || !event || typeof event !== "object") return;
  const isSubagent = "parent" in event && event.parent !== null;
  void apiPost("observe", {
    hookType: isSubagent ? "subagent_start" : "agent_start",
    // ...
    data: {
      tool_name: isSubagent ? "subagent_start" : "agent_start",
      agent_id: "agentId" in event ? String(event.agentId) : undefined,
      parent_id: "parent" in event && event.parent ? String((event.parent as any).id) : undefined,
    },
  });
});
```

若 OMP 实际未提供 `parent`/`agentRole` 字段,则该 bug 是 OMP 设计层面的限制——本 issue 应记录为 OMP 集成层需要修补。

## 验证步骤

1. 启动新 OMP 会话,确认只有 1 个 `subagent_start` 观察入库
2. 在该会话中派生子 agent(Task 工具或 OMP 等效),确认 +1 个 `subagent_start`
3. 修复前:`subagent_start` 计数 = 2(主 agent + 子 agent)
4. 修复后:`subagent_start` 计数 = 1(仅子 agent)

**与 [P1-019] omp-subagent-stop-missing(已作为 020 编号)互补**——两个 bug 共同形成"非对称生命周期"问题:start 错误触发,end 完全缺失。
