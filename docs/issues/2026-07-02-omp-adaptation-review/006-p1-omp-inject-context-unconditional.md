# [P1-006] OMP 集成无视 `AGENTMEMORY_INJECT_CONTEXT` opt-in,无条件注入上下文

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:248-265
**类别**:cross-file(既有契约)

## 问题

```ts
pi.on("before_agent_start", async (event) => {
  if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
  // ... 无条件调用 smart-search + 返回 { systemPrompt: ... }
});
```

Claude plugin 的 `src/hooks/pre-tool-use.ts:23` 和 `session-start.ts:19` 都 gate 在 `AGENTMEMORY_INJECT_CONTEXT === "true"` 上,且 `src/index.ts:296-304` 在 boot 时打印大声警告。OMP 完全没有 gate,直接根据 `serverOk` 决定是否注入。

## 影响

- 从未 opt-in 上下文注入的 OMP 用户会在每个 turn 静默消耗 ~4000 chars 的会话 token
- 在 Claude Pro 等按 session 计费的套餐上等同于计费 token,产生真实费用
- OMP boot 没有任何警告,用户不知道自己在被注入
- 与 Claude plugin 行为不一致,用户从 Claude 切到 OMP 时无法预测 token 消耗

## 触发场景

1. 用户在 Claude Code 中 `AGENTMEMORY_INJECT_CONTEXT=false`(默认)
2. 用户切换到 OMP 集成
3. 每个 turn 注入 ~4000 chars 到 systemPrompt
4. 用户账单/会话配额意外减少

## 修复

```ts
pi.on("before_agent_start", async (event) => {
  if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
  if (process.env.AGENTMEMORY_INJECT_CONTEXT !== "true") return;  // ← 增加 opt-in gate
  // ... 其余逻辑
});
```

并在 OMP boot 时(如果有日志 hook)打印同样的警告。

## 相关位置

- `src/hooks/pre-tool-use.ts:23`(`const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";`)
- `src/hooks/session-start.ts:19`(同上)
- `src/index.ts:296-304`(boot 时警告)