# [P1-008] `tool_execution_end` 把成功和失败路径合并,缺失 `post_tool_failure` hookType

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:232-244
**类别**:cross-file(服务端契约)

## 问题

```ts
pi.on("tool_execution_end", async (event: unknown) => {
  if (!serverOk || !event || typeof event !== "object") return;
  const toolName = "toolName" in event ? String(event.toolName) : "unknown";
  const toolResult = "result" in event ? JSON.stringify(event.result) : "";
  void apiPost("observe", {
    hookType: "post_tool_use",   // ← 永远是 success,失败也被标记为成功
    data: { tool_name: toolName, tool_output: truncate(toolResult, 2000) },
  });
});
```

Claude plugin(`plugin/scripts/post-tool-failure.mjs`)区分 `post_tool_use`(成功)和 `post_tool_failure`(失败,带 `error` 字段)。OMP 合并为单一路径,无错误分支。

服务端 `src/functions/observe.ts:102-109` 对两个 hookType 都读取 `d["tool_input"]`:

```ts
if (payload.hookType === "post_tool_use" || payload.hookType === "post_tool_failure") {
  raw.toolName = d["tool_name"] as string | undefined;
  raw.toolInput = d["tool_input"];
  raw.toolOutput = d["tool_output"] || d["error"];
}
```

## 影响

- **下游分析失真**:任何查询 `hookType=post_tool_failure` 的消费者在 OMP 环境下看到零行(但失败实际发生过)
- **去重假阴性**:`dedupMap.computeHash` 以 `tool_input` 为 key——失败观察以 `toolInput: undefined` 保存,与原始输入关联丢失,与 `tool_execution_start`(第 218-230 行,确实发 `tool_input`)不一致
- **错误信息丢失**:失败时 `toolResult` 可能包含错误堆栈,但被 `truncate(toolResult, 2000)` 当作普通 output 截断存储

## 触发场景

```ts
// OMP 调用一个抛错的工具
pi.on("tool_execution_end", { toolName: "bad_tool", result: { error: "ENOENT" } });
// OMP 发送:
// { hookType: "post_tool_use", data: { tool_name: "bad_tool", tool_output: "{\"error\":\"ENOENT\"}" } }
// 服务端不知道这是失败
```

## 修复

检查 OMP 的 `tool_execution_end` 事件是否有 `isError` / `error` 字段(类似 Claude 的 `hookSpecificOutput.permissionDecision`)。如果有,分支处理:

```ts
pi.on("tool_execution_end", async (event: unknown) => {
  if (!serverOk || !event || typeof event !== "object") return;
  const toolName = "toolName" in event ? String(event.toolName) : "unknown";
  const isError = "isError" in event ? Boolean(event.isError) : false;
  const toolResult = "result" in event ? JSON.stringify(event.result) : "";
  void apiPost("observe", {
    hookType: isError ? "post_tool_failure" : "post_tool_use",
    data: {
      tool_name: toolName,
      tool_input: "",  // 失败时也应该发,即使空
      tool_output: isError ? undefined : truncate(toolResult, 2000),
      error: isError ? truncate(toolResult, 2000) : undefined,
    },
  });
});
```

需要确认 OMP `tool_execution_end` 事件的实际 schema 后再实施。