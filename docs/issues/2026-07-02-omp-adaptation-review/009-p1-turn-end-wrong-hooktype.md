# [P1-009] `turn_end` 用 `hookType: "post_tool_use"` 上报助手消息,语义错误

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts`
**行**:277-284
**类别**:line-by-line(语义错配)

## 问题

```ts
pi.on("turn_end", async (event: unknown) => {
  if (!serverOk || !event || typeof event !== "object") return;
  if (!("messages" in event) || !Array.isArray(event.messages)) return;
  for (const msg of [...event.messages].reverse()) {
    if (!msg || typeof msg !== "object") continue;
    if (!("role" in msg) || msg.role !== "assistant") continue;
    const text = getText("content" in msg ? msg.content : "");
    if (!text) break;
    void apiPost("observe", {
      hookType: "post_tool_use",   // ← 不是工具调用
      data: { tool_name: "conversation", tool_output: truncate(text, 4000) },
    });
    break;
  }
});
```

助手回复不是工具调用,服务端会按 post_tool_use 处理。

## 影响

- `toolName: "conversation"` 会被当成真实的工具名进入工具注册表的去重/统计逻辑,污染下游分析
- 服务端 `src/functions/observe.ts:102-109` 对 `post_tool_use` 会读 `tool_input`,但这里没发 `tool_input`,导致 `toolInput: undefined`
- 与 [issue 008](./008-p1-tool-execution-end-no-error-branch.md) 同样的 `tool_input` 缺失问题

## 触发场景

每次 OMP session 结束一个 turn 时,服务端观察表里多一行 `toolName: "conversation"` 的"假工具调用",污染 `src/state/vector-index.ts` 的工具调用统计。

## 修复

改用专用 hookType:

```ts
void apiPost("observe", {
  hookType: "turn_complete",   // ← 新 hookType,或用现有的 "assistant_message"
  sessionId,
  project: currentProject,
  cwd: currentProject,
  timestamp: new Date().toISOString(),
  data: { tool_name: "assistant_message", tool_output: truncate(text, 4000) },
});
```

需要在服务端 `src/functions/observe.ts` 增加 `turn_complete` hookType 的处理分支(或确认现有 hookType 列表中是否有合适的)。

## 相关位置

- `src/functions/observe.ts`(服务端 observe handler,需要新增 hookType 分支)
- `src/hooks/post-tool-use.ts`(Claude plugin 对应实现,作为对照)