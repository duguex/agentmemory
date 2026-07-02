# [P1-022] OMP `before_agent_start` 当 `systemPrompt=""` 时产出 `\n\n## Recalled from memory...`——前导换行作为完整系统提示

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:269-287`
**类别**:line-by-line(空值检查缺失)

## 问题

```ts
pi.on("before_agent_start", async (event: unknown) => {
  if (!serverOk || sessionInjected || !event || typeof event !== "object") return;
  if (!isInjectContextEnabled()) return;
  if (!("prompt" in event) || typeof event.prompt !== "string" || !event.prompt) return;
  sessionInjected = true;
  const result = await apiPost<...>("smart-search", { query: event.prompt, limit: 5 });
  if (!result?.results?.length) return;
  const lines = result.results.map(...);
  const recallBlock = `## Recalled from memory\n${lines.join("\n")}`;
  if ("systemPrompt" in event && typeof event.systemPrompt === "string") {  // ← 第 283 行
    return { systemPrompt: event.systemPrompt + "\n\n" + recallBlock };  // ← 第 284 行
  }
  return { systemPrompt: recallBlock };  // ← 第 286 行
});
```

第 283 行的 `typeof event.systemPrompt === "string"` 检查对**空字符串也通过**。

## 触发场景

OMP/Pi 的 `before_agent_start` 事件,当 host agent 没有基础系统指令时,`systemPrompt` 可能为 `""`:

1. OMP 事件 `before_agent_start` 携带 `systemPrompt: ""`、`prompt: "修复 bug"`
2. 第 272 行 `!event.prompt` 为 false(prompt 非空),继续执行
3. 第 283 行 `"systemPrompt" in event` 为 true,`typeof "" === "string"` 为 true,**进入 if 分支**
4. 第 284 行返回 `{ systemPrompt: "" + "\n\n" + "## Recalled from memory\n..." }` = `{ systemPrompt: "\n\n## Recalled from memory\n..." }`
5. LLM 接收 `\n\n## Recalled from memory\n  [fact] Foo` 作为完整系统提示
6. 模型行为:无任何 agent 指令,只有 recall 块,且前面有两个换行符污染格式

## 影响

- LLM 失去 agent 的基础指令(角色、约束、风格)
- LLM 上下文格式污染(前导 `\n\n`)
- 用户感知:agent 行为怪异,没有遵守常规约束
- 与 `event.systemPrompt` 完全缺失(走 else 分支)的语义不一致——空字符串应该是"没有指令",应走 else 分支

## 修复

将第 283 行的检查从 `"systemPrompt" in event && typeof event.systemPrompt === "string"` 改为同时校验真值:

```ts
if (
  "systemPrompt" in event &&
  typeof event.systemPrompt === "string" &&
  event.systemPrompt
) {
  return { systemPrompt: event.systemPrompt + "\n\n" + recallBlock };
}
return { systemPrompt: recallBlock };
```

或更显式:

```ts
const basePrompt =
  "systemPrompt" in event && typeof event.systemPrompt === "string" && event.systemPrompt
    ? event.systemPrompt + "\n\n"
    : "";
return { systemPrompt: basePrompt + recallBlock };
```

## 验证步骤

1. 配置 OMP/Pi 事件使其 `before_agent_start` 携带 `systemPrompt: ""`
2. 启用 `AGENTMEMORY_INJECT_CONTEXT=true`
3. 触发首次 recall
4. 检查返回给 LLM 的 system prompt
5. 修复前:`"\n\n## Recalled from memory\n..."`;修复后:`"## Recalled from memory\n..."`

**这是与 P1-006(inject-context-unconditional)和 P1-017(sessionInjected 污染)同一处理器内的第三个 bug**——`before_agent_start` handler 是问题高发区。
