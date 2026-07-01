# [P0-004] claude-bridge 和 graph-extraction handler 未注册,功能静默失效

**严重度**:🔴 P0
**文件**:`src/index.ts`
**行**:60-61(import), 281(dead variable)
**类别**:removed-behavior

## 问题

diff 删除了两个条件注册块:

```ts
// 旧代码(已被删除)
if (claudeBridgeConfig.enabled) {
  registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
  bootLog(`Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`);
}

if (isGraphExtractionEnabled()) {
  registerGraphFunction(sdk, kv, provider);
  bootLog(`Knowledge graph: extraction enabled`);
}
```

但 `registerClaudeBridgeFunction` 和 `registerGraphFunction` 的 import 在第 60-61 行保留。`grep -rn registerClaudeBridgeFunction src/` 显示仅剩定义和 import,没有调用点。`claudeBridgeConfig`(第 281 行)成为 dead variable。

## 影响

- **Claude bridge**:设置 `CLAUDE_MEMORY_BRIDGE=true` 时,`src/triggers/api.ts:1378` 和 `:1399` 调用 `mem::claude-bridge-read` / `mem::claude-bridge-sync`,但 handler 未注册,SDK 静默 no-op。Claude Code 的 `~/.claude/memory.md` 不再被同步
- **Graph extraction**:设置 `GRAPH_EXTRACTION_ENABLED=true` 时,5 个 handler(`mem::graph-extract`/`graph-query`/`graph-stats`/`graph-snapshot-rebuild`/`graph-reset`)都未注册。`src/triggers/api.ts:1442, 1460, 1484, 1509, 1538` 调用这些 function_id 全部失败
- **死代码**:`src/index.ts:60-61` 两个 import 永远不会被 tree-shake 掉,TS strict mode 下可能产生 unused-import 警告

## 触发场景

1. 用户在 `~/.agentmemory/.env` 设置 `CLAUDE_MEMORY_BRIDGE=true` 和 `GRAPH_EXTRACTION_ENABLED=true`
2. 启动 agentmemory
3. 调用 `/agentmemory/claude-bridge/sync` 或 `/agentmemory/graph/extract` HTTP 端点
4. 服务端返回 function-not-registered 错误,但 bootLog 没有警告(因为根本没有进入条件分支)

## 修复

恢复两个条件注册块:

```ts
const claudeBridgeConfig = loadClaudeBridgeConfig();
if (claudeBridgeConfig.enabled) {
  registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig);
  bootLog(`Claude bridge: syncing to ${claudeBridgeConfig.memoryFilePath}`);
}

if (isGraphExtractionEnabled()) {
  registerGraphFunction(sdk, kv, provider);
  bootLog(`Knowledge graph: extraction enabled`);
}
```

或者,如果有意彻底移除 bridge/graph 功能,应该一并删除:
- `src/functions/claude-bridge.ts`
- `src/functions/graph.ts`
- `src/triggers/api.ts:1378, 1399, 1442, 1460, 1484, 1509, 1538`(对应的 trigger 注册)
- `src/config.ts` 中 `loadClaudeBridgeConfig` 和 `isGraphExtractionEnabled`

**当前状态是"既不修复也不彻底移除",这是最糟糕的状态**——既没有功能,也没有代码清理。

## 验证步骤

1. 设置 `CLAUDE_MEMORY_BRIDGE=true`
2. 启动 agentmemory
3. `curl -X POST http://localhost:3111/agentmemory/claude-bridge/sync`
4. 预期(应工作但实际失败):返回 `{"success": true}`;实际:返回 function-not-registered 错误