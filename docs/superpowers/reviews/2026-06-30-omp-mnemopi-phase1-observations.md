# Phase 1 观察记录

**日期**: 2026-06-30
**OMP 版本**: v16.1.7
**配置**: memory.backend: mnemopi, polyphonicRecall: true, per-project-tagged

---

## 观察表

| 观察项 | 实际结果 | 备注 |
|--------|----------|------|
| `<memories>` 块是否出现 | ✅ 已注入 | agent 确认 autoRecall=true 生效 |
| `<memories>` 块格式 | markdown 表格 | agent 在 `/memory stats` 中以格式化表格呈现 |
| agent 是否主动提及记忆 | 部分 | 仅查询时回答，不主动提及 |
| `/memory stats` 输出 | ✅ 完整有效 | 显示 banks/tables/embeddings/config，格式为 markdown 表格 |
| `/memory view` 输出 | 未测试 | 需要交互式 session |
| `/memory enqueue` 行为 | 未测试 | 需要交互式 session |
| autoRetain 是否触发 | ✅ 是 | 两个 session 各 1 条 working_memory，共 2 条 |
| 跨 session 召回 | ✅ 是 | "what did we do" → 正确回答了前次 session 内容 |
| 项目隔离 | ✅ 是 | 仅一个项目 bank `memory-ijdv1ii4x3ph`，全局 bank 无数据 |
| 嵌入模型 | ✅ BGE-base-en-v1.5 | 2 条 embedddings 已生成（768维向量） |
| 记忆数据库路径 | `~/.omp/agent/memories/mnemopi/` | spec 中的推测路径 `~/mnemopi/` 错误，更新为实际路径 |
| 事实提取 | ⚠️ 空 | facts 表有结构但事实数组为空（`{"facts":[]}`） |
| tiny-models 下载 | ❌ 未完成 | lfm2-350m 未下载完成，但 BGE-base-en-v1.5 已缓存且正常工作 |

---

## 数据库结构（已确认）

```
~/.omp/agent/memories/mnemopi/
├── mnemopi.db                    # 全局共享 bank (37K)
└── banks/
    └── memory-ijdv1ii4x3ph/      # 项目 bank (101K)
        └── mnemopi.db
```

**核心表**:
- `working_memory` — 会话原文（agent 自动 retain）
- `memory_embeddings` — BGE-base-en-v1.5 768维向量
- `facts` — 结构化事实（当前为空，需更多数据触发提取）
- `annotations` — 时间戳与来源标记
- `episodic_memory` / `triples` / `graph_edges` — 尚为空

---

## 三要素评估

| 需求 | pi-mnemopi 当前能力 | 差距 |
|------|---------------------|------|
| **项目意图** | 🟡 有项目隔离，但无结构化 profile | 不知道项目"目的"，仅知道工作目录 |
| **开发历程** | 🟢 working_memory 存了会话原文，可实现跨 session 回顾 | 可接受，但无摘要/里程碑 |
| **本地资源** | 🔴 无 | 完全不追踪资源位置 |

---

## 决策建议

**pi-mnemopi 已激活且正常工作。** 它的优势：
- ✅ 零成本激活
- ✅ 跨 session 召回有效
- ✅ 嵌入 + FTS 检索
- ✅ 项目隔离

但它**仅存会话原文**，无法满足 "项目意图/本地资源" 这两个结构化需求。

建议：
1. **保留 pi-mnemopi** 作为会话连续性记忆
2. **Phase 2 增加 Superpowers 自动化** — 在 agent_end 时触发 session 摘要写入
3. **考虑 agentmemory 补充结构化记忆** — 它有 Pi plugin、类型系统、置信度评分
