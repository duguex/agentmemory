# [P0-027] `claudeBridgeConfig` 与 `isGraphExtractionEnabled()` 既是死变量又是死调用——比 P0-004 更严重的"假装存在"

**严重度**:🔴 P0(独立于 P0-004 的更严重维度)
**文件**:`src/index.ts:60-61, 281` + `src/triggers/api.ts:1373-1612` + `src/functions/claude-bridge.ts` + `src/functions/graph.ts`
**类别**:removed-behavior + altitude(未完成的删除)

## 问题

P0-004 已记录了 `registerClaudeBridgeFunction` 和 `registerGraphFunction` 未被注册的事实。本条 issue 进一步指出 **删除不彻底**:

### 死代码地图

1. **src/index.ts:60-61**:两个 import(`registerClaudeBridgeFunction`、`registerGraphFunction`)依然存在
2. **src/index.ts:281**:`claudeBridgeConfig = loadClaudeBridgeConfig()` 赋值但从未读取
3. **src/functions/claude-bridge.ts**:整个文件依然存在,定义 handler 实现
4. **src/functions/graph.ts**:整个文件依然存在,定义 5 个 graph handler
5. **src/triggers/api.ts:1373-1413**:`api::claude-bridge-read` 和 `api::claude-bridge-sync` HTTP 触发器依然注册,内部调用 `mem::claude-bridge-read/sync`
6. **src/triggers/api.ts:1442,1460,1484,1509,1538,1524,1578**:`api::graph-*` 5 个端点依然注册
7. **src/config.ts**:`loadClaudeBridgeConfig()` 和 `isGraphExtractionEnabled()` 依然导出

这是"假装删除"的反模式——表面上删除了注册,但**所有支撑代码依然存在**,导致:

### 状态 1:功能静默失效

`CLAUDE_MEMORY_BRIDGE=true` 或 `GRAPH_EXTRACTION_ENABLED=true` 的用户:
- 启动时 bootLog 无任何提示(因为 if 分支被删了,根本进不去 bootLog)
- 触发 HTTP 端点 → SDK 返回 function-not-registered 错误
- 用户感知:配置生效,但实际不工作,无任何日志线索

### 状态 2:死代码浪费

- 两个 import 永远不会被 tree-shake
- 两个函数文件(几百行)永远不会被引用
- `claudeBridgeConfig` 变量永远被赋值
- TS strict 模式可能产生 unused-import 警告
- 增加 bundle 体积和构建时间

## 影响

- **用户视角**:配置生效但静默失效,无任何提示
- **维护者视角**:看到代码存在以为功能可用,实际不工作
- **构建视角**:死代码增加包大小
- **架构视角**:三种状态(完整、假装删除、完全删除)中,假装删除是最差的——既无功能也无清理

## 修复

二选一:

### 方案 A:恢复条件注册(功能完整)

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

并删除 P0-003 提到的"两个 `_cleanupTimers` 数组"的混乱(本文件无关,仅参考)。

### 方案 B:彻底删除(代码清理)

删除:
- src/index.ts:60-61 两个 import
- src/index.ts:281 `claudeBridgeConfig` 赋值
- src/functions/claude-bridge.ts 整个文件
- src/functions/graph.ts 整个文件
- src/triggers/api.ts:1373-1413 两个 HTTP 触发器
- src/triggers/api.ts:1442,1460,1484,1509,1524,1538,1578 graph 触发器
- src/config.ts 中 `loadClaudeBridgeConfig` 和 `isGraphExtractionEnabled`
- 相关 README/env 文档

并在 AGENTS.md 中记录"claude-bridge 和 graph-extraction 功能已废弃"。

## 触发场景

1. 用户配置 `CLAUDE_MEMORY_BRIDGE=true`
2. 启动 agentmemory,bootLog 无 Claude bridge 行
3. 用户期望 Claude bridge 工作
4. 实际:HTTP 端点返回 404
5. 调试过程:看到 `src/functions/claude-bridge.ts` 文件存在,误以为功能可用
6. 进一步调试:发现 `src/triggers/api.ts` 中端点定义存在,但调用 `mem::claude-bridge-read` 未注册
7. 浪费数小时定位"为什么功能不工作"

## 验证步骤

### 方案 A 验证
1. 设置 `CLAUDE_MEMORY_BRIDGE=true`
2. 启动 agentmemory
3. 检查 bootLog:`Claude bridge: syncing to /path/to/memory.md`
4. `curl -X POST http://localhost:3111/agentmemory/claude-bridge/sync`
5. 预期:返回 `{success: true}`

### 方案 B 验证
1. 删除后启动 agentmemory
2. 检查 bootLog:无 Claude bridge 行
3. `curl -X POST http://localhost:3111/agentmemory/claude-bridge/sync`
4. 预期:返回 404 Not Found(端点不存在,而非 function-not-registered)
5. 构建产物不包含 `claude-bridge.ts` 或 `graph.ts`

**这是 P0-004 的更严重版本——不只是"功能失效",而是"功能假装存在"**。
