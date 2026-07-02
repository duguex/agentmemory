# [P1-023] OMP 缺少 `isSdkChildContext` 守卫——子 agent 加载扩展时形成递归观察

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`(整个文件)
**类别**:removed-behavior(对比 Claude `src/hooks/_shared/isSdkChildContext.ts`)

## 问题

Claude 插件每个 hook 脚本顶部都有:

```ts
import { isSdkChildContext } from "./_shared/sdk-child-context.js";
// ...
if (isSdkChildContext(payload)) return;
```

该函数检查:
1. `process.env.AGENTMEMORY_SDK_CHILD === "1"`(子 agent 设置该环境变量)
2. payload 中 `agentId` 或 `entrypoint` 字段指示这是 SDK 子上下文

若任一为真,hook 直接返回,防止观察递归污染。

OMP 扩展**完全缺少**该守卫。

## 影响

OMP 触发的工具调用如果派生出子 agent,且子 agent 也加载 `agentmemory-omp` 扩展(同一 Node 模块):

1. 父 OMP 进程触发工具,产生 `tool_execution_start/end` 观察
2. 工具派生子 agent(例如 Bash 启动 `claude-code --with-omp` 子进程)
3. 子 agent 加载 `agentmemory-omp`,子进程继承环境变量,可能也继承 `sessionId`(因为子进程从父 cwd 启动,而 `currentProject = process.cwd()` 在子进程中指向相同路径)
4. 子 agent 触发 `agent_start`,`tool_execution_start/end` 等观察,**sessionId 与父会话相同**
5. 父会话的观察流被子 agent 的观察污染
6. `kv.list(KV.observations(parentSessionId))` 包含父+子的混合观察,无法区分

Claude 通过 `AGENTMEMORY_SDK_CHILD=1` 环境变量防止此问题——子进程显式标记自己是 SDK 子上下文。

## 触发场景

1. 父 OMP 进程启动,`sessionId = auto-abc123`
2. 父 agent 调用 Bash 工具:`claude-code --with-omp /some/task`
3. 子进程加载 `agentmemory-omp`,但未设置 `AGENTMEMORY_SDK_CHILD=1`
4. 子 agent 的 `session_start` 触发,OMP 发送 `session/start` 给服务器,**新生成的 sessionId**
5. 子 agent 工作,所有 `tool_execution_*`、`turn_end` 观察被打上子 sessionId
6. **但**若子 agent 复用了父进程的 process.cwd()(通过继承),且 OMP 没重新生成 sessionId,观察被打上**父** sessionId
7. 父会话观察到子 agent 的工具调用,污染数据

实际风险大小取决于 OMP 子进程是否真的复用 sessionId。但**缺少守卫**本身已经是设计缺陷。

## 修复

在 OMP 扩展入口处添加守卫:

```ts
export default function agentmemoryExtension(pi: ExtensionAPI) {
  // SDK 子上下文守卫——子 agent 不应递归观察
  if (process.env.AGENTMEMORY_SDK_CHILD === "1") {
    return;  // 空扩展,所有 hook 都是 no-op
  }

  let sessionId = `auto-${Date.now().toString(36)}`;
  // ...
}
```

并在父 agent 派生子进程时设置环境变量(若 OMP 支持):

```ts
const child = spawn("claude-code", [...args], {
  env: { ...process.env, AGENTMEMORY_SDK_CHILD: "1" },
});
```

## 验证步骤

1. 父 OMP 进程,`sessionId = auto-parent`
2. 派生子进程,该进程也加载 `agentmemory-omp`
3. 子进程设置 `AGENTMEMORY_SDK_CHILD=1`
4. 子 agent 工作,触发 `tool_execution_*` 观察
5. 修复前:子观察污染父 sessionId;修复后:子扩展是 no-op,无观察入库
6. 检查 `kv.list(KV.observations("auto-parent"))` 仅包含父会话的观察

**这是与 P1-007、P1-021 同一类"会话边界"问题的延伸**——会话边界不清,递归/泄漏无法避免。
