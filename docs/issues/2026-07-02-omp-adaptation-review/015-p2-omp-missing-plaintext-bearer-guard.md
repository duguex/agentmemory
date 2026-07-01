# [P2-015] OMP 缺少 pi extension 的 `createPlaintextBearerAuthGuard`

**严重度**:🟡 P2
**文件**:`integrations/omp/index.ts` vs `integrations/pi/security.ts`
**行**:27-32
**类别**:reuse + 安全隐患

## 问题

`integrations/pi/security.ts` 提供 `createPlaintextBearerAuthGuard`,在 `AGENTMEMORY_SECRET` 已设置但 `AGENTMEMORY_URL` 是 `http://` 时打印大声警告:

```ts
// integrations/pi/security.ts(伪代码)
export function createPlaintextBearerAuthGuard() {
  return () => {
    const url = process.env.AGENTMEMORY_URL;
    const secret = process.env.AGENTMEMORY_SECRET;
    if (url?.startsWith("http://") && secret) {
      console.warn("[agentmemory] WARNING: Sending bearer token over plaintext HTTP. Use https:// in production.");
    }
  };
}
```

OMP 完全跳过这个 guard,直接无条件发 `Authorization: Bearer <secret>`。

## 影响

- 用户意外把 OMP 指向 `http://` 且设置了 secret,bearer token 会被静默泄漏给路径上的任何攻击者(中间人、运营商、内网嗅探器)
- 没有任何告警,用户完全不知道
- 违反 RFC 6750 § 2.3: bearer token 不应在明文通道发送(without TLS)

## 触发场景

```bash
# 用户在咖啡店用手机热点连,误把 URL 写成 http
AGENTMEMORY_URL=http://agentmemory.local:3111 \
AGENTMEMORY_SECRET=secret_abc123 \
omp

# 任何在路径上的嗅探器都能拿到 secret_abc123
```

## 修复

复用 pi extension 的 guard:

```ts
// integrations/_lib/security.ts(新建共享文件)
export function createPlaintextBearerAuthGuard() {
  let warned = false;
  return () => {
    const url = process.env.AGENTMEMORY_URL;
    const secret = process.env.AGENTMEMORY_SECRET;
    if (!warned && url?.startsWith("http://") && secret) {
      console.warn("[agentmemory] WARNING: Sending bearer token over plaintext HTTP. Use https:// in production.");
      warned = true;
    }
  };
}
```

在 OMP `authHeaders()` 中调用:

```ts
const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();

function authHeaders(): Record<string, string> {
  guardPlaintextBearerAuth();   // ← 增加 guard
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const s = secret();
  if (s) h.Authorization = `Bearer ${s}`;
  return h;
}
```

## 相关位置

- `integrations/pi/security.ts`(完整实现)
- `integrations/pi/index.ts:5`(`import { createPlaintextBearerAuthGuard } from "./security.js"`)
- `integrations/openclaw/plugin.mjs`(也需要确认是否有类似 guard)