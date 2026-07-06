# Issue — Daemon 重启后检索链路完整诊断

**日期**：2026-07-05
**关联**：
- spec：`docs/superpowers/specs/2026-07-04-backfill-compression-fix-design.md`
- plan：`docs/superpowers/plans/2026-07-04-backfill-compression-unification.md`
- 上游 issue：`docs/issues/2026-07-04-backfill-compression-design-review.md` 等
- 修复 commit：`c5a0c84` (delete-then-set schema lock bypass)

---

## 1. 背景

完成 12-task backfill compression unification 计划后：
- ✅ 19 个 plan-related commits + 4 个 final-review-fix commits
- ✅ Schema lock bug 修复（commit c5a0c84，delete-then-set）
- ✅ LLM 升级路径端到端验证：18/18 obs 升级到 `compressionKind: "llm"`
- ✅ BM25 检索返回 LLM 标题
- ✅ 上下文注入返回相关历史
- ⚠️ **未验证**：Vector 语义检索、Graph 实体检索、Rerank

为了真正达成 `final_purpose.md` 的目标（"高质量记忆 + 检索"），需要重启 daemon 让 vector index 重新初始化。

---

## 2. 操作日志

### 2.1 重启前的状态

| 项目 | 数值 |
|------|------|
| Daemon PID | 2340468（启动于 2026-07-05 05:34，运行 13.5 小时）|
| iii-engine PID | 2340539（保留未重启）|
| KV obs 总数 | 646 个 .bin 文件（`~/.agentmemory/data/state_store.db/mem%3Aobs*`）|
| KV graph 总数 | 6 个 .bin 文件（nodes / edges / name-index / snapshot / degree / edge-key）|
| KV vector 持久化 | ❌ **无**（vector index 是 in-memory 单例，重启即清空）|
| Ollama | ✅ 运行中（port 11434, model `nomic-embed-text`）|
| Embedding 配置 | `EMBEDDING_PROVIDER=openai`，指向 `localhost:11434/v1`，768 维 |

### 2.2 重启操作

```bash
cd ~/memory/agentmemory
npm run build                                              # ✅ Build complete in 7142ms
kill 2340468                                               # ✅ Daemon 停止
sleep 3                                                    # 等待 graceful shutdown
ps aux | grep agentmemory | grep -v grep                   # ✅ 确认已停止
nohup agentmemory > /tmp/daemon-fresh.log 2>&1 &          # ✅ 新 daemon 启动 PID 2504937
sleep 8                                                    # 等启动完成
```

### 2.3 重启后观察

| 观察项 | 结果 |
|--------|------|
| Boot log `Embedding provider: openai (768 dims)` | ❌ **未显示**（bootLog 输出被 CLI 拦截，未写入 log 文件）|
| Boot log `Embedding provider: none (BM25-only mode)` | ❌ **未显示**（同上）|
| Daemon 响应 health | ✅ status: healthy, uptime: 90s |
| iii-engine 仍在运行 | ✅ PID 2340539 |
| 重建 vectorIndex | ❓ **未知**（无日志可查）|
| 重建 BM25 index | ❓ **未知**（应在第一次 search 时 lazy rebuild）|

---

## 3. 检索测试结果（重启后）

### 3.1 新创建的 obs 能被检索

```bash
# POST 一个新 obs（schema: hookType, sessionId, project, cwd, timestamp, data）
POST /agentmemory/observe → 返回 obsId
sleep 3
POST /agentmemory/smart-search {"query":"vector verify test","limit":3}
# → 返回 3 个 hits，但都是旧的 /tmp/test_* obs
```

### 3.2 大量 keyword 测试

| Query | 命中 | 是否找到 backfill obs |
|-------|------|---------------------|
| `synthetic hook observation` | 5 hits | ❌ 全是 `/tmp/test_*` |
| `empty payload notification` | 3 hits | ❌ 全是 `/tmp/test_*` |
| `database locking issue iii-engine` | 3 hits | ❌ 全是 `/tmp/test_*` |
| `webui pages overview clusters` | 3 hits | ❌ 全是 `/tmp/test_*` |
| `schema lock bypass delete then set` | 3 hits | ❌ 全是 `/tmp/test_*` |

### 3.3 关键问题

**646 个 backfill obs（包括 LLM-compressed 的）没有任何一个出现在搜索结果中**。

只有最近几分钟创建的几条 `/tmp/test_*` obs 能被命中。

---

## 4. 已知的根因候选

### 4.1 BM25 index 重建失败或未完成

代码逻辑（`src/functions/search.ts:399-402`）：
```typescript
if (idx.size === 0) {
  const count = await rebuildIndex(kv);
  logger.info('Search index rebuilt', { entries: count });
}
```

- **理论**：第一次 search 应触发 rebuild，加载 646 obs
- **实际**：rebuild 可能失败但 `logger.info` 输出未持久化（OTel exporter=memory）
- **或**：rebuild 静默跳过某些 obs（dedup / schema mismatch）

### 4.2 Rebuild 索引数据源问题

让我看 `rebuildIndex`（`src/functions/search.ts:221`）的代码：
- `idx.clear()` — 清空 BM25
- `vectorIndex?.clear()` — 清空 vector
- 然后循环 `kv.list` 加载所有 obs
- 对每个 obs 调用 `idx.add` 和 `vectorIndexAddGuarded`

可能问题：
- 旧 backfill obs（schema lock bug 修复前导入）schema 与新代码期望不一致
- 重建是**全量**还是**增量**？
- rebuild 是同步还是异步？

### 4.3 Vector 初始化未发生

- `vectorIndex` 是在 daemon 启动时 `embeddingProvider ? new VectorIndex() : null` 决定的
- 如果 `embeddingProvider` 为 null，则 `vectorIndex = null`，所有 vector 操作**静默跳过**
- 但 ollama 现在可达，所以 `embeddingProvider` 应该非 null
- **未知**：daemon boot 时 `embeddingProvider` 实际状态（无 log 可查）

### 4.4 Ollama 实际可用性

刚才 `curl http://localhost:11434/api/tags` 返回模型列表 — Ollama 运行中
但 daemon 启动时（90 秒前）是否能成功连接 — 未知

### 4.5 Circuit breaker 仍 open

重启前 health 显示 `circuitBreaker.state: open`，4 次连续失败
重启后 circuit breaker 状态：**未知**（未查）

---

## 5. 待做的诊断步骤

### 5.1 立即可做（不需重启）

1. **查看 `~/.agentmemory/logs/`** 是否存在日志（应不存在，OTel exporter=memory）
2. **看 iii-engine 是否有 stderr 日志**
3. **触发一次 search，sleep 60s，再 search 看 idx.size 是否增加**（如果是 lazy rebuild）
4. **直接调用 `rebuildIndex` 函数**（如果有暴露端点）
5. **查询 daemon log**：
   ```bash
   ls /tmp/daemon-fresh.log
   cat /tmp/daemon-fresh.log | grep -iE "rebuild|embed|vector|index"
   ```

### 5.2 可能需要重启

6. **kill + restart with stderr 捕获**：
   ```bash
   pkill -f "node.*agentmemory"
   nohup agentmemory > /tmp/daemon-verbose.log 2>&1 &
   # 看 boot 时是否有 "Embedding provider: ..." 行
   ```

7. **设 RERANK_ENABLED=true 重启**，验证 Rerank 库加载

### 5.3 数据层验证

8. **看 646 个 obs 的 schema**：
   - 哪些是 LLM-compressed（`compressionKind: "llm"`）
   - 哪些是 synthetic
   - 哪些是更老的 raw schema

9. **看 `kv.list` 是否能列出所有 obs**，或某些 session 被分页限制

---

## 6. 假设的诊断结论（待验证）

### 假设 A · BM25 rebuild 失败

- 触发 search 时报内部错误被 catch
- 没有日志输出
- idx.size 仍为 0
- 修复：手动调用 `rebuildIndex`，或重启 daemon with verbose logging

### 假设 B · Vector embed 失败（circuit breaker）

- `vectorIndexAddGuarded` 内部 catch 失败
- 已有 obs 重建时被跳过
- BM25 OK，vector 永久为空
- 修复：清空 circuit breaker 状态（或重启 daemon）

### 假设 C · rebuild 完成但 search 路径有 bug

- idx.size > 0
- 但 search 结果不包含旧 obs
- 修复：深挖 search.ts 检索逻辑

### 假设 D · 旧 obs schema 与新代码不兼容

- rebuild 时跳过不匹配的 obs
- 只有最近新创建的 obs 进索引
- 修复：schema 迁移或迁移脚本

---

## 7. 影响

**`final_purpose.md` 目标暂时无法验证为达成**：

| 目标 | 状态 |
|------|------|
| 处理 OMP 历史为高质量记忆 | ✅ LLM 升级路径完整 |
| 检索质量高 | ⚠️ **仅 BM25-only**，Vector/Graph 未验证 |
| 用于上下文注入 | ⚠️ 仅基于 BM25 的 inject 工作 |
| 适配不同 coding agent | ✅ 框架就绪 |

如果假设 A/B/C/D 之一成立，需要再做一个 follow-up plan 才能真正完成。

---

## 8. 下一步建议

1. **先做 5.1 的非破坏性诊断**（5-10 分钟）
2. 根据诊断结果决定是否需要：
   - 写一个独立的"诊断 + 修复" plan
   - 或者直接 patch 现有的搜索/重建代码

---

## 附录 A · 关键代码位置

| 文件 | 行 | 描述 |
|------|-----|------|
| `src/functions/search.ts:399-402` | 自动 rebuildIndex 触发 |
| `src/functions/search.ts:221` | rebuildIndex 函数定义 |
| `src/index.ts:227-229` | vectorIndex 初始化（依赖 embeddingProvider）|
| `src/functions/search.ts:94-126` | vectorIndexAddGuarded（静默失败）|
| `iii-config.yaml:38-55` | OTel exporter=memory（无 log 持久化）|

## 附录 B · 当前环境数据

```
Ollama: http://localhost:11434/v1 (model: nomic-embed-text, 768 dims)
Daemon PID: 2504937 (uptime ~3min at time of issue)
iii-engine PID: 2340539 (running, not restarted)
KV obs count: 646 (per `find ~/.agentmemory/data -name "mem%3Aobs*" | wc -l`)
KV graph count: 6 (per `find ~/.agentmemory/data -name "mem%3Agraph*" | wc -l`)
Vector index size: UNKNOWN (in-memory only)
BM25 index size: UNKNOWN (likely 0 after restart, should rebuild on first search)
```

---

## 9. 诊断进展（2026-07-05 续）

### 9.1 重启后验证（issue 步骤 5.1）

- ✅ Issue 已创建：https://github.com/rohitg00/agentmemory/issues/1015
- ✅ Daemon 已重启：旧 PID 2340468 → 新 PID 2504937
- ✅ Boot log 可读（之前 CLI 拦截，现在通过 `cat /tmp/daemon-fresh.log`）

### 9.2 检索测试结果

```
GET  /agentmemory/sessions?limit=5  → 97 sessions (84 backfill + 13 test)
GET  /agentmemory/observations?sessionId=<backfill-019eb9a6>  → 18 obs with title+narrative
POST /agentmemory/search  {"query":"webui"}  → 0 results ❌
POST /agentmemory/search  {"query":"a"}       → 0 results ❌
POST /agentmemory/smart-search  {"query":"a"}  → 3 results (titles empty — likely auto-mr26fjra session remnants)
```

### 9.3 关键发现

#### 发现 1 · 持久化索引**文件存在但内容已过时**

```
-rw-rw-r-- 1 duguex duguex 41832  7月  5 03:42 mem%3Aindex%3Abm25%3Avectors%3Aidx_mr6rr28q_fb483307b67f%3A00000.bin
-rw-rw-r-- 1 duguex duguex 41408  7月  5 03:42 mem%3Aindex%3Abm25%3Abm25%3Aidx_mr6rr28d_a259743b9994%3A00000.bin
-rw-rw-r-- 1 duguex duguex   380  7月  5 03:42 mem%3Aindex%3Abm25.bin
```

**时间戳 7/5 03:42** — 这是凌晨的 daemon 进程写入的。**当前 daemon (20:33 启动) 从未写入过索引文件**。

#### 发现 2 · 索引文件内容只含 `auto-*` session entries，不含 backfill

`mem%3Aindex%3Abm25%3Abm25%3Aidx_mr6rr28d_*.bin` 内容（截取）：
```json
{"v":2,"entries":[["obs_mr2anjax_*",{"sessionId":"auto-mr26fjra",...}],...],"inverted":[...]}
```

只包含 `auto-mr26fjra` / `auto-mr2aozw0` / `memory` 三类 session 的 entries。**完全没有 `backfill-*` session 或任何 `obs_mr7*` 类型**。

#### 发现 3 · `needsRebuild` 逻辑漏洞（最关键）

`src/index.ts:473`：
```typescript
const needsRebuild = bm25Index.size === 0;
if (needsRebuild) {
  // Fire-and-forget rebuildIndex ...
}
```

**bug**：如果持久化索引加载成功但只包含旧 session（`auto-*`），`size > 0` → `needsRebuild = false` → **不会自动 rebuild 包含 backfill 数据**。

但**实际**当前 search 返回 0 — 说明**加载也失败了**，因为如果加载成功，至少 auto-* 应该返回 hits。

#### 发现 4 · load 路径可能静默失败

`src/state/index-persistence.ts:349-457` `loadShardedData` / `loadManifestData`：

```typescript
if (chunk.length !== shard.chars) {
  logger.warn(`index persistence: ${label} shard length mismatch`, ...);
  return null;
}
```

任何 shard 加载失败 → 返回 null → load 返回 null → boot 不打 "Loaded" log → 但 daemon 也不报错。

**可能的具体失败点**：
- shard scope 读取失败（KV adapter 兼容性问题）
- chunk 长度不匹配 manifest.chars（数据损坏）
- `manifest.v !== 1` 校验失败

### 9.4 未验证项

| 项 | 状态 |
|-----|------|
| `bootLog("Embedding provider: ...")` 内容 | ❓ verbose log 未开 |
| `bootLog("Loaded persisted BM25 index (N docs)")` | ❌ log 未出现（可能 load 失败） |
| Vector index load 状态 | ❓ 类似问题（41KB shard 文件存在）|
| Graph index state | ❓ `searchByEntities` 是否工作未测 |
| Ollama 实际可达性 | ❓ boot 时是否连接成功未知 |
| Rerank 状态 | ❌ `RERANK_ENABLED` 未设 |

---

## 10. 当前最可能根因（综合判断）

**最可能**：持久化索引文件**存在但加载失败**（discovery 4），导致 `bm25Index.size === 0`，**应该**触发 `needsRebuild=true`，但 `rebuildIndex` 是 fire-and-forget 且 `logger.info` 走 OTel exporter=memory，没有 stdout 输出，所以**我们看不到 rebuild 是否完成**。

Smart-search 能返回 3 个空 title 的结果，说明 HybridSearch 的 fallback 路径使用了某种其他数据源（可能是 mem::remember 的 memory entries，不是 obs）。

---

## 11. 建议的下一步诊断（追加）

1. **重启 daemon with `AGENTMEMORY_VERBOSE=1`** — 开启 boot log 看到 Embedding provider / Loaded BM25 index 状态
2. **等 60 秒**让 lazy rebuild 完成
3. **再 search** — 如果 rebuild 成功，所有 646 backfill obs 应可命中
4. **如果仍然 0 结果** → 实际跑 `rebuildIndex()` 函数（需要写一个小脚本或加临时 endpoint）

---

## 12. 推荐的修复方案（待诊断确认）

### 修复 A · `needsRebuild` 逻辑

让 `needsRebuild` 不仅看 size，还要看 size 是否代表**完整 corpus**：
```typescript
// 比较索引里的 sessionIds vs KV 里实际 sessions
const indexedSessions = new Set<string>(/* extract from bm25 */);
const actualSessions = await kv.list<Session>(KV.sessions);
const missingSessions = actualSessions.filter(s => !indexedSessions.has(s.id));
const needsRebuild = bm25Index.size === 0 || missingSessions.length > 0;
```

### 修复 B · 添加 search-index-rebuild API 端点

让运维可以手动触发 rebuild：
```typescript
// api::search-index-rebuild
POST /agentmemory/search/index-rebuild → 触发 rebuildIndex
```

### 修复 C · Embedding provider 状态显式化

在 boot log 中**强制**显示 Embedding provider 状态（即使 verbose=0）：

### 修复 D · 持久化索引内容一致性检查

`rebuildIndex` 完成后验证 size > 实际 obs count 的 80%（粗略检查），否则 warning。

---

## 13. 验收条件

- [ ] 重启后第一次 search 在 60s 内能返回 backfill 数据
- [ ] `smart-search` 返回的 hits 中 `compressionKind: "llm"` 比例 > 50%
- [ ] Vector search 实测工作（语义 query 返回非关键词 hits）
- [ ] Graph search 实测工作（entity-based query 返回相关 obs）
- [ ] boot log 显式显示 Embedding provider 状态
- [ ] 持久化索引 load 失败有 warning 而不是 silent null