# [P1-029] 环境变量重命名 `AUTO_FORGET_INTERVAL_MS` → `AGENTMEMORY_AUTO_FORGET_INTERVAL` 无迁移路径,生产部署行为静默变化

**严重度**:🟠 P1
**文件**:`src/config.ts:156-160` + `src/index.ts:263-271, 545-556`
**类别**:altitude(环境契约变更无迁移)

## 问题

新增代码读取新环境变量名:

```ts
// src/config.ts:156-160
export function getAutoForgetIntervalMs(): number {
  const val = getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL") || "";
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
```

而 src/index.ts:545 仍读取旧环境变量名:

```ts
const autoForgetIntervalMs = parseInt(process.env.AUTO_FORGET_INTERVAL_MS || "3600000", 10);
```

两个环境变量名指向不同的调度路径,但功能相同——`AGENTMEMORY_AUTO_FORGET_INTERVAL` 是新代码用,`AUTO_FORGET_INTERVAL_MS` 是旧代码用。**没有任何迁移警告或回退逻辑**。

## 影响

升级到本分支的现有部署:

1. 运维配置文件 `.env` 中已有 `AUTO_FORGET_INTERVAL_MS=600000`(10 分钟)
2. 升级后,该配置仍被旧定时器读取,按 10 分钟运行
3. 新定时器因 `AGENTMEMORY_AUTO_FORGET_INTERVAL` 未设置而**默认禁用**(返回 0)
4. 用户期望新版本生效,实际行为不变
5. **没有任何日志或警告提示运维需要更新变量名**

类似地,`AGENTMEMORY_EVICT_INTERVAL` 是新名字,但旧代码没有 evict 定时器(本次新增),所以 evict 没有冲突——但运维文档/AGENTS.md 都没有记录这个新变量名。

## 触发场景

### 场景 A:现有部署升级

1. 运维设置 `AUTO_FORGET_INTERVAL_MS=600000`(旧变量)
2. 升级到本分支
3. 启动 agentmemory
4. bootLog 显示 `Auto-forget: scheduled every 3600000ms`(来自旧的 549 行,**不是**用户设置的 600000ms)
5. 因为旧代码读 `AUTO_FORGET_INTERVAL_MS || "3600000"`,但用户设置了 600000——应该 600000 才对
6. 实际:**两个定时器并存,新定时器用 1 小时默认,旧定时器用用户设置的 10 分钟**
7. 用户期望:10 分钟一次。实际:旧 10 分钟 + 新 1 小时

### 场景 B:全新部署

1. 运维查阅新文档,设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=600000`(新变量名)
2. 新定时器按 10 分钟触发,旧定时器也按 1 小时默认触发
3. 用户期望:10 分钟一次。实际:10 分钟 + 1 小时并存

## 修复

### 方案 A:统一变量名(推荐)

删除旧 `AUTO_FORGET_INTERVAL_MS` 路径,所有代码用 `AGENTMEMORY_AUTO_FORGET_INTERVAL`:

```ts
// src/index.ts:548-556 替换为
const autoForgetMs = getAutoForgetIntervalMs();
if (autoForgetMs > 0) {
  // ... 复用第 268-271 行的 setInterval
}
// 删除第 545 行的旧变量
```

并在 bootLog 中显式提示变量名变更:

```ts
if (process.env.AUTO_FORGET_INTERVAL_MS && !process.env.AGENTMEMORY_AUTO_FORGET_INTERVAL) {
  bootLog(`WARNING: AUTO_FORGET_INTERVAL_MS is deprecated; use AGENTMEMORY_AUTO_FORGET_INTERVAL instead`);
}
```

### 方案 B:回退兼容

让 `getAutoForgetIntervalMs()` 同时读取旧变量名作为回退:

```ts
export function getAutoForgetIntervalMs(): number {
  const newVal = getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL");
  const oldVal = getEnvVar("AUTO_FORGET_INTERVAL_MS");  // 旧名字
  const val = newVal || oldVal || "";
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
```

并在 bootLog 中:

```ts
if (oldVal && !newVal) {
  bootLog(`DEPRECATED: AUTO_FORGET_INTERVAL_MS → AGENTMEMORY_AUTO_FORGET_INTERVAL (auto-migrated)`);
}
```

### 方案 C:文档同步

在 AGENTS.md、README.md 中添加迁移指南,列出所有重命名:

- `AUTO_FORGET_INTERVAL_MS` → `AGENTMEMORY_AUTO_FORGET_INTERVAL`

并删除旧变量名的所有引用。

## 验证步骤

1. 设置 `AUTO_FORGET_INTERVAL_MS=600000`(旧变量名)
2. 升级到本分支,启动 agentmemory
3. 检查 bootLog
4. 修复前:无任何迁移提示,行为静默
5. 修复后:显示 "DEPRECATED: AUTO_FORGET_INTERVAL_MS → AGENTMEMORY_AUTO_FORGET_INTERVAL"
6. 实际调度按用户意图运行(无重复)

**这是与 P0-003(双轨定时器)同源的环境契约问题**——只修 P0-003(删除一份定时器)不够,还需修环境变量迁移。
