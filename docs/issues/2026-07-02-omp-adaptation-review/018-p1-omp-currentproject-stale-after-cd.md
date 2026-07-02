# [P1-018] OMP `currentProject` 仅在模块初始化和 session_start 时刷新;用户 `cd` 后所有观察都被错误打标签

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:110, 174 + 191-313`
**类别**:line-by-line(状态陈旧)

## 问题

`currentProject` 在两处赋值:

```ts
// 第 110 行:模块初始化时
let currentProject = process.cwd();

// 第 174 行:session_start 处理器中
pi.on("session_start", async () => {
  sessionId = `auto-${Date.now().toString(36)}`;
  currentProject = process.cwd();  // ← 仅在 session_start 时刷新
  // ...
});
```

所有 8 个发送 observe 的处理器(turn_start、agent_start、auto_compaction_start、tool_execution_start、tool_execution_end、turn_end 等)都从闭包读取 `currentProject`,**从不调用 `process.cwd()`**。

## 影响

- 用户在 `/work/frontend` 启动 OMP 会话
- 中途 `cd /work/backend` 继续工作
- `session_start` 不重新触发(长会话),`currentProject` 仍是 `/work/frontend`
- cd 之后**每个**工具调用、提示、turn_end 都被打上 `project=/work/frontend` 标签
- 这些观察污染 `frontend` 项目的 KV scope
- 当用户在 frontend 项目执行 `agentmemory_search` 时,会拉取到 backend 工作的观察
- 当 `before_agent_start` 注入上下文时(若未被 P1-017 阻断),会拉取 frontend 记忆而用户正在做 backend 工作

## 与已有 P1-012 的关系

[P1-012](./012-p1-omp-resolveproject-contract-drift.md) 指出 OMP 用了 `process.cwd()` 而不是 `resolveProject`(src/hooks/_project.ts)。本条 issue 是**该 bug 的下游放大**——即便使用 `resolveProject`,只要不在每个事件 handler 中调用,`cd` 后仍然是错的。

正确实现应该参考 `src/hooks/_project.ts:21-23` 的优先级链(AGENTMEMORY_PROJECT_NAME 环境变量 → `git rev-parse --show-toplevel` → `basename(cwd)`),并在**每个事件 handler 顶部**重新解析。

## 修复

提取共享解析函数:

```ts
function resolveCurrentProject(): string {
  const explicit = process.env.AGENTMEMORY_PROJECT_NAME;
  if (explicit) return explicit;
  try {
    const { execSync } = require("node:child_process");
    return execSync("git rev-parse --show-toplevel", { cwd: process.cwd() }).toString().trim();
  } catch {
    return require("node:path").basename(process.cwd());
  }
}
```

每个 observe 处理器顶部调用一次(或在 `makeObserve()` 工厂中调用),而不是依赖闭包变量。

## 触发场景

1. 用户在 OMP 中工作于 frontend 项目(`cd /work/frontend && omp`)
2. 工作 30 分钟后 `cd /work/backend`(同一 OMP 会话未退出)
3. 用户在 backend 执行 Bash("pytest")
4. OMP `tool_execution_end` 触发,发送 `project: /work/frontend`(陈旧)
5. 观察被存入 frontend 的 KV scope
6. frontend 项目的 `agentmemory_search` 检索到 "pytest" 相关观察——污染数据

## 验证步骤

1. 在项目 A 中启动 OMP 会话
2. `cd` 到项目 B
3. 在 B 中执行任意工具调用
4. 检查服务器日志中 observe 调用的 `project` 字段
5. 修复前:`project=A`;修复后:`project=B`

**这是与 P1-012 同源的 bug**——`resolveProject` 契约应该在每个事件点执行,而非会话级缓存。
