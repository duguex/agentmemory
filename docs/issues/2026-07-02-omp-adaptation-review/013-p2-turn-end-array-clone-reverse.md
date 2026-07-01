# [P2-013] `[...event.messages].reverse()` 在长会话中全量克隆消息数组

**严重度**:🟡 P2
**文件**:`integrations/omp/index.ts`
**行**:272
**类别**:efficiency

## 问题

```ts
for (const msg of [...event.messages].reverse()) {
  if (!msg || typeof msg !== "object") continue;
  if (!("role" in msg) || msg.role !== "assistant") continue;
  const text = getText("content" in msg ? msg.content : "");
  if (!text) break;
  // ...
  break;
}
```

`[...event.messages]` 创建完整浅拷贝 + `.reverse()` 创建另一个拷贝,两者都是 O(n) 内存分配。对长会话(数百条消息)每个 turn 都做两次分配。

## 影响

- 每次 `turn_end` 多分配 ~N × pointer 大小的内存(数百条消息就是几 KB)
- GC 压力增加
- 在内存敏感的嵌入式环境可能成为问题

## 触发场景

长会话(200+ 条消息) + 频繁 turn_end(每个 turn 都触发) → 每秒数十次分配

## 修复

反向 `for` 循环,零分配:

```ts
const msgs = event.messages;
for (let i = msgs.length - 1; i >= 0; i--) {
  const msg = msgs[i];
  if (!msg || typeof msg !== "object") continue;
  if (!("role" in msg) || msg.role !== "assistant") continue;
  const text = getText("content" in msg ? msg.content : "");
  if (!text) break;
  void apiPost("observe", { /* ... */ });
  break;
}
```

或使用 `Array.prototype.findLast`(Node 18+):

```ts
const lastAssistant = event.messages.findLast(
  (msg): msg is { role: string; content: unknown } =>
    !!msg && typeof msg === "object" && "role" in msg && (msg as { role: unknown }).role === "assistant"
);
if (lastAssistant) {
  const text = getText("content" in lastAssistant ? lastAssistant.content : "");
  if (text) {
    void apiPost("observe", { /* ... */ });
  }
}
```