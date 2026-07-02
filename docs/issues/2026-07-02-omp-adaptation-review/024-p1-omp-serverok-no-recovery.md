# [P1-024] OMP `serverOk` 仅在 `session_start` 设置一次,守护进程宕机后无恢复路径——整个会话观察静默丢失

**严重度**:🟠 P1
**文件**:`integrations/omp/index.ts:177-185` + 每个 `pi.on` handler 的 `if (!serverOk) return`
**类别**:line-by-line(状态机无恢复路径)

## 问题

```ts
// 第 177-184 行
pi.on("session_start", async () => {
  sessionId = `auto-${Date.now().toString(36)}`;
  currentProject = process.cwd();
  sessionInjected = false;
  const result = await apiPost("session/start", { sessionId, project: currentProject, cwd: currentProject });
  serverOk = result !== null;  // ← 仅此一处赋值
});
```

`serverOk` 在 `session_start` 时设置一次。后续每个 observe handler 都检查 `if (!serverOk) return`。

但 `serverOk` **永不重新探测**——即使后续守护进程恢复,`serverOk` 保持 false(如果初始 session_start 失败)或保持 true(即使后续守护进程崩溃,observe POST 全部 null 但 serverOk 不翻)。

## 影响

### 场景 A:session_start 时守护进程宕机

1. 用户启动 OMP,守护进程尚未启动
2. `session_start` POST 返回 null,`serverOk = false`
3. 用户后续工作 30 分钟,所有 8 个 observe handler 都因 `serverOk=false` 短路
4. **整个会话的观察全部丢失,无任何日志提示**
5. 用户运行 `agentmemory_status` 工具会探测一次并更新 `serverOk`,但**没有任何机制触发该调用**

### 场景 B:session_start 后守护进程崩溃

1. OMP 会话启动时正常,`serverOk = true`
2. 5 分钟后守护进程崩溃
3. 后续 observe POST 全部返回 null(apiPost 吞掉错误)
4. `serverOk` 保持 true(因为只在 session_start 时赋值)
5. **handler 全部"以为"正常,继续 silent no-op**
6. 守护进程 10 分钟后重启,OMP 仍不知情
7. `serverOk` 永远不翻,无任何观察入库

## 触发场景

场景 A 在新部署或开发调试时极易触发(用户先启动 OMP,后启动守护进程)。
场景 B 在长会话 + 守护进程不稳定的生产环境中常见。

## 修复

**方案 A(轻量)**:在每次 `apiPost` 失败时降级 `serverOk`,并周期性重新探测:

```ts
async function apiPost<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const response = await fetch(url, { ... });
    if (!response.ok) {
      // 5xx 错误降级 serverOk,但不永久
      if (response.status >= 500) serverOk = false;
      return null;
    }
    serverOk = true;  // 成功响应 → serverOk 恢复
    return await response.json();
  } catch {
    serverOk = false;
    return null;
  }
}
```

**方案 B(彻底)**:在工具调用间隙定时探测:

```ts
setInterval(async () => {
  const health = await apiGet("health");
  serverOk = !!(health && health.status === "healthy");
}, 60_000).unref();
```

**方案 C(组合)**:`apiPost` 内部根据 HTTP 状态码动态翻转 `serverOk`,并在每次失败 POST 中加入 1% 概率的主动 health 探测。

## 验证步骤

1. 启动 OMP,**不**启动 agentmemory 守护进程
2. 工作 30 秒(任何工具调用、提示)
3. 启动 agentmemory 守护进程
4. 再工作 30 秒
5. 修复前:第 1 个 30 秒的观察全部丢失,第 2 个 30 秒仍因 `serverOk=false` 丢失
6. 修复后:`serverOk` 在第 1 次成功 health check 时自动翻转,后续观察正常入库

**这是与 P1-021(session_shutdown 丢失)互补的会话内可靠性问题**——会话两端都不可靠。
