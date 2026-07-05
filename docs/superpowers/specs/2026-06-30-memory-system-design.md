# OMP 持久记忆系统设计

**日期**: 2026-06-30
**状态**: 设计稿，待审核后实施

## 1. 问题定义

### 1.1 现状

- OMP v16.1.7 内置 `pi-mnemopi` 记忆后端，默认关闭 (`memory.backend: off`)
- 用户使用 OMP 一个月，未感知到记忆系统存在
- Superpowers 已通过 Pi extension 集成，hooks 系统就绪
- 三个核心需求未被满足：
  1. **项目意图** — 了解项目背景、目的、方向
  2. **开发历程** — 知道做过的、正在做的、将要做的
  3. **本地资源** — 文档/DB/其他项目的位置和关系

### 1.2 成功标准

- 每次 session 启动，agent 自动感知项目上下文并有所呈现
- agent 在工作过程中主动记录关键决策、资源、进度
- session 结束时自动总结，持久化
- 用户能通过命令查看记忆状态
- 记忆跨 session 保持有效

## 2. 方案选择

**方案 A（选定）**: 激活 OMP 原生记忆 `pi-mnemopi` + Superpowers 自动化增强

选型理由：
- 零新增依赖，基于 OMP 已内置的能力
- polyphonicRecall 四路召回 + RRF 融合成熟度高
- per-project-tagged scoping 支持项目隔离+全局共享
- 实现成本最低，可快速验证效果

## 3. 架构

```
┌─────────────────────────────────────────────────┐
│                  用户交互层                        │
│  agent 主动提及记忆  /  /memory 命令               │
└─────────────────────┬───────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────┐
│              Agent 行为层                         │
│  ┌─────────────────────────────────────────────┐│
│  │ Memory Management Skill（可选 Phase 2）       ││
│  │ 指导 agent: 何时写记忆、怎么查、如何呈现       ││
│  └─────────────────────────────────────────────┘│
├─────────────────────────────────────────────────┤
│              自动化层（Superpowers）               │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │Session   │  │AgentEnd  │  │Context Hook   │ │
│  │Start Hook│  │Hook(新增)│  │(已有,增强)     │ │
│  └──────────┘  └──────────┘  └───────────────┘ │
├─────────────────────────────────────────────────┤
│              存储引擎层（OMP 内置）                │
│  ┌─────────────────────────────────────────────┐│
│  │ pi-mnemopi (memory.backend: mnemopi)         ││
│  └─────────────────────────────────────────────┘│
└─────────────────────────────────────────────────┘
```

### 3.1 存储布局（推测，待验证）

```
~/.omp/agent/
├── mnemopi/                    # 记忆数据库目录（推测路径，待验证）
│   ├── mnemopi.db             # 全局共享记忆（WAL+SHM）
│   └── <project_hash>.db      # 每个项目的独立记忆
├── config.yml                  # memory 配置段
└── tiny-models/                # ONNX 嵌入模型（下载后）
```

> 注意：`mnemopi/` 目录路径是推测。OMP 文档只说 "agent memories directory"，实际路径需激活后确认。

### 3.2 数据流

**Session 启动**:
```
1. OMP 启动 pi-mnemopi 后端
2. autoRecall=true → 生成 <memories> 块注入首轮 context
3. Superpowers SessionStart hook → 注入 bootstrap + 项目上下文
4. Agent 看到 <memories> → 可选择性地呈现给用户
```

**工作中**:
```
1. autoRetain=true → 每 N 轮自动 retain 当前会话
2. agent 可主动调用 /memory enqueue 强制写入
3. 关键决策点 → agent 通过工具调用写入结构化记忆（Phase 2）
```

**Session 结束**:
```
1. pi-mnemopi 在 compact 时自动调用 preCompactionContext
2. 后续：agent_end hook 触发 session 摘要写入（Phase 2）
```

## 4. 配置设计

### 4.1 OMP Config（`~/.omp/agent/config.yml` 追加）

```yaml
memory:
  backend: mnemopi

mnemopi:
  scoping: per-project-tagged    # 项目隔离 + 全局可见
  autoRecall: true               # session 首轮自动召回
  autoRetain: true               # 自动保留会话
  polyphonicRecall: true         # 四路多模态召回
  recallLimit: 12                # 最多召回 12 条
  retainEveryNTurns: 3           # 每 3 轮 retain
  injectionTokenLimit: 6000      # 记忆块 token 预算
  embeddingVariant: en           # BAAI/bge-base-en-v1.5（已缓存）
```

### 4.2 模型管理

```bash
# 下载内存嵌入模型（Phase 1 必须）
omp tiny-models download lfm2-350m
```

`BAAI/bge-base-en-v1.5` 已存在于 HF 缓存，是默认嵌入模型，无需额外下载。

## 5. Phase 计划

### Phase 1 — 激活与观察（当前可执行）

**步骤**:
1. 修改 `~/.omp/agent/config.yml` 追加 memory 配置
2. 运行 `omp tiny-models download lfm2-350m` 下载记忆 LLM 模型
3. 启动一次正常 session，观察以下现象：

**观察清单**:

| 观察项 | 预期 | 实际记录 |
|--------|------|----------|
| session 首轮是否出现 `<memories>` 块 | 应包含召回记忆 | TBD |
| `<memories>` 块的内容格式 | 纯文本记忆列表 | TBD |
| agent 是否主动提及记忆 | 可能选择性呈现 | TBD |
| `/memory stats` 输出 | 显示记忆统计数据 | TBD |
| `/memory view` 输出 | 显示记忆条目 | TBD |
| `/memory enqueue` 行为 | 强制写入当前会话 | TBD |
| autoRetain 是否在 3 轮后触发 | 后台写入 | TBD |
| 第二次 session 是否召回前次记忆 | 跨 session 有效 | TBD |
| 项目 A 的记忆是否会出现在项目 B | 应不出现（隔离） | TBD |

**交付物**: 填写观察清单，决定 Phase 2 优化方向。

### Phase 2 — Superpowers 自动化增强（基于观察结果）

**候选增强**:

| 问题 | 增强方案 |
|------|----------|
| `<memories>` 块太简陋 | SessionStart hook 额外注入结构化 project context |
| agent 不主动利用记忆 | 新增 memory-management skill |
| autoRetain 存的内容太粗糙 | agent_end 事件触发 session 摘要写入 |
| 缺少显式记忆管理 | 通过 custom hook 或 extension 添加 `/remember`、`/recall` 命令（非 OMP 原生） |
| 项目初始无记忆 | 首次 session 自动扫描 README/git log 初始化 |

**仅在观察到对应问题后才实施，不超前实现。**

### Phase 3 — 可选集成（根据实际需求）

| 场景 | 方案 |
|------|------|
| 跨机器同步记忆 | Mnemosyne sync / cloud backend |
| 更强结构化事实 | Mem0 plugin for Pi（已存在） |
| 外部系统集成 | MCP 记忆服务 |

## 6. 风险与限制

### 已知限制

- `<memories>` 是 background context（非 instructions），agent 可忽略
- pi-mnemopi 存储架构不可自定义 schema（SQLite + 嵌入向量，不能定义结构化字段）
- 嵌入模型质量取决于 BGE-base-en-v1.5 的领域覆盖
- autoRecall 召回质量取决于 polyphonicRecall 的实际实现效果

### 回退方案

如果 Phase 1 观察发现 pi-mnemopi 召回效果差或不可用：
1. 降级到 `noEmbeddings: true`（纯 FTS 检索）
2. 或改用 `memory.backend: off`，完全通过 Superpowers skill + MCP 自定义实现

## 7. 未解决问题

- `<memories>` 块的具体格式 — 需激活后观察
- 嵌入模型的下载是否正常 — `omp tiny-models download` 观察到进度即完成
- polyphonicRecall 需要的最小模型 — 需实际测试
- 项目隔离的 hash 算法 — OMP 内部实现，无需配置
