# [P1-030] `getAutoForgetIntervalMs` 和 `getEvictIntervalMs` 是 `safeParseInt` 的复制实现——重复 + 略不同语义

**严重度**:🟠 P1
**文件**:`src/config.ts:156-166` + `src/config.ts:14-18`(已存在的 `safeParseInt`)
**类别**:reuse + altitude(应使用既有 helper)

## 问题

新增的两个函数:

```ts
// 第 156-160 行
export function getAutoForgetIntervalMs(): number {
  const val = getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL") || "";
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// 第 162-166 行
export function getEvictIntervalMs(): number {
  const val = getEnvVar("AGENTMEMORY_EVICT_INTERVAL") || "";
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
```

而代码库已有 `safeParseInt`:

```ts
// src/config.ts:14-18(待确认)
function safeParseInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
```

新函数与 `safeParseInt` 的差别:
- `safeParseInt` 在 NaN 时返回 `fallback`
- 新函数在 `parsed <= 0` 时返回 `0`,但 `parsed > 0` 且 finite 时返回 `parsed`
- 语义:**"未设置或非正数 → 禁用(0)"**,这与 `safeParseInt` 的 fallback 不同

## 影响

### 重复

每新增一个 interval 定时器,需要再写一个 `getXxxIntervalMs()` 函数。当前有 2 个,但潜在会有 N 个。

### 语义漂移

`safeParseInt` 接受 fallback(如 3600000),但新函数硬编码 fallback = 0(禁用)。如果后续有人修改 `safeParseInt` 接受 `min` 选项,新函数又会偏离。

### 调用方需要额外检查

```ts
const autoForgetMs = getAutoForgetIntervalMs();
if (autoForgetMs > 0) {  // ← 重复的 0 检查
  // schedule
}
```

调用方既要函数返回值,又要检查 `> 0`——语义不清晰(0 是"禁用"还是"立即触发"?)

## 修复

**方案 A**:扩展 `safeParseInt` 接受 `min` 选项:

```ts
function safeParseInt(
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number },
): number {
  const parsed = parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (options?.min !== undefined && parsed < options.min) return options.min;
  if (options?.max !== undefined && parsed > options.max) return options.max;
  return parsed;
}

// 使用
const autoForgetMs = safeParseInt(
  getEnvVar("AGENTMEMORY_AUTO_FORGET_INTERVAL"),
  0,
  { min: 0 },  // 0 表示禁用
);
```

**方案 B**:提取 `getPositiveIntervalMs(envVar: string): number`:

```ts
function getPositiveIntervalMs(envVar: string): number {
  const parsed = parseInt(getEnvVar(envVar) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// 使用
const autoForgetMs = getPositiveIntervalMs("AGENTMEMORY_AUTO_FORGET_INTERVAL");
const evictMs = getPositiveIntervalMs("AGENTMEMORY_EVICT_INTERVAL");
```

## 验证步骤

1. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=invalid`
2. 启动 agentmemory
3. 调用 `getAutoForgetIntervalMs()` 直接测试
4. 期望:返回 0(禁用)
5. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=-100`
6. 期望:返回 0(负数禁用)
7. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=0`
8. 期望:返回 0(`> 0` 检查失败)
9. 设置 `AGENTMEMORY_AUTO_FORGET_INTERVAL=60000`
10. 期望:返回 60000

## 与已有 issue 的关系

无直接已有 issue。但这是与 P0-003(双轨定时器)、P1-029(环境变量迁移)同源的 config 层设计问题——应该统一通过 `safeParseInt` 或类似 helper 处理,而不是复制两份。

**这是 config 层的"小重复大问题"——单看不严重,但累积会导致每个新 interval 都引入 5 行重复代码**。
