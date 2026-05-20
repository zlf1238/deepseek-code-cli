# Skill 子智能体与 Explorer：Flash 多角色委派架构

借鉴 [DeepSeek Reasonix](https://github.com/esengine/reasonix) 的 Skill → Subagent 映射机制和 Explorer 子智能体设计，在现有 Supervisor-Worker 架构基础上扩展 Flash 子智能体的角色矩阵，实现"Explorer 探索 + Fixer 修改 + Skill 技能驱动"三层 Flash 委派体系。

---

## 一、背景与问题

### 1.1 现有痛点的全面回顾

| 痛点 | 场景 | 后果 |
|---|---|---|
| **Skill 全量注入 Pro 上下文** | `SkillLoad("code-review")` → 145 行正文 + Pro 读 6 个文件 + grep 4 次 → 全部堆积在 Pro 会话 | 单次审查膨胀 ~8000 行上下文，Pro 缓存持续劣化 |
| **Pro 亲自做探索** | Pro `grep` + `read_file` × N 来理解代码结构 | Pro output ¥6/M 烧在读文件上，而非做决策 |
| **Fixer 单次超时** | 8 文件改动塞进一个 `spawn_code_executor` → 8 轮迭代不够 → TIMEOUT | 92s 白等 + ¥0.11 白烧 |
| **缺少探索专用子智能体** | 只有 Fixer（改代码），没有 Explorer（探索代码） | 每次"找调用点/评估影响面"都要 Pro 亲自 grep+read |

### 1.2 成本数据

| | Pro (每百万 token) | Flash (每百万 token) | 倍数 |
|---|---|---|---|
| Input cache-hit | ¥0.025 | ¥0.02 | 1.25× |
| Input cache-miss | ¥3.0 | ¥1.0 | 3× |
| Output | ¥6.0 | ¥2.0 | 3× |

**核心洞见**：Pro 的 output 成本是 Flash 的 3 倍。把只读探索和代码修改从 Pro 移到 Flash，直接降本 60-80%。

---

## 二、决策思路

### 2.1 方案对比

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 提升 Pro 能力 | Pro 更好的提示词，减少无效探索 | 零代码 | Pro output ¥6/M 无法改变 |
| B. 增加 Fixer 迭代上限 | `MAX_ITERS: 8` → 更大值 | 一行改动 | 治标不治本 |
| C. Skill Subagent + Explorer | Skill frontmatter 驱动 runAs + 专用 Explorer 工具 | 根本解决角色分化 + 成本结构优化 | 需新增代码 |

**选 C 的理由**：

1. 方案 A 不改变成本结构—Pro output 仍然是 ¥6/M
2. 方案 B 推迟超时不解决"Pro 不该亲自探索"的问题
3. 方案 C 从根本上改变工作分配：Pro 做决策，Flash 做执行和探索

### 2.2 为什么用 `runAs` frontmatter 而非硬编码

| 选项 | 理由 |
|---|---|
| 硬编码 Skill 列表 | 每新增 Skill 要改代码 |
| **YAML frontmatter** | ✅ 用户/项目自行创建 Skill，零代码扩展 |

```yaml
---
name: my-skill
runAs: subagent       # inline | subagent
allowed-tools: read_file, grep, gitnexus_query
model: deepseek-v4-flash
max-tool-iters: 15
---
```

### 2.3 为什么共享 `runSkillSubagent` 循环而非各自实现

```
spawn_code_executor (Fixer) ──┐
spawn_explorer (Explorer) ────┼──→ runSkillSubagent() ──→ Flash API
SkillLoad("explore") ─────────┘
```

三个入口共享同一套"隔离循环 + Flash client + usage 追踪 + TIMEOUT 处理"，差异仅在于 **system prompt + 工具白名单 + 迭代上限**。

### 2.4 工具分发的两种策略

| 策略 | 使用场景 | 实现 |
|---|---|---|
| **switch 分发**（旧 Fixer） | 只用到 read_file/edit_file/write_file 的小修改 | `handleCodeExecutorTool` 内的 switch |
| **ToolExecutor 分发**（新 Skill/Explorer） | 需要 grep/glob/gitnexus/bash/web 等全工具集 | `runSkillSubagent` 通过动态 import 调用 `ToolExecutor.executeToolCalls` |

ToolExecutor 方式的循环依赖通过动态 import 解决：
```typescript
const { ToolExecutor } = await import("./executor");
```

---

## 三、架构设计

### 3.1 Flash 子智能体角色矩阵

```
┌─────────────────────────────────────────────────────────┐
│                    Pro (Supervisor)                      │
│            保持热缓存，只做决策/设计/验证                  │
│            工具: read, grep, ask, skill-load ...         │
└──┬──────────────┬──────────────┬──────────────┬─────────┘
   │              │              │              │
   ▼              ▼              ▼              ▼
┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
│Explorer │  │ Fixer   │  │ Reviewer│  │ Tester  │
│  探索者  │  │  修改者  │  │  审查者  │  │  测试工  │
├─────────┤  ├─────────┤  ├─────────┤  ├─────────┤
│工具:    │  │工具:    │  │工具:    │  │工具:    │
│gitnexus*│  │read_file│  │read_file│  │read_file│
│grep     │  │edit_file│  │grep     │  │grep     │
│glob     │  │write    │  │gitnexus*│  │bash     │
│web_*    │  │grep     │  │glob     │  │gitnexus*│
│bash     │  │         │  │bash     │  │         │
├─────────┤  ├─────────┤  ├─────────┤  ├─────────┤
│20轮     │  │12轮     │  │12轮     │  │16轮     │
│flash    │  │flash    │  │flash    │  │flash    │
└─────────┘  └─────────┘  └─────────┘  └─────────┘
   │              │              │              │
   │         ┌─────────┐        │              │
   │         │Researcher│       │              │
   │         │  研究员  │        │              │
   │         ├─────────┤        │              │
   │         │web_*    │        │              │
   │         │read_file│        │              │
   │         │15轮     │        │              │
   │         └─────────┘        │              │
   └─────────── Skill (runAs: subagent) ──────┘
```

### 3.2 Skill 双模式执行路径

```
SkillLoad({name:"code-review"})
        │
        ├── SKILL.md frontmatter: runAs = "subagent"
        │       │
        │       └──→ runSkillSubagent(context, systemPrompt=SKILL.md body, ...)
        │               │
        │               ├── Flash API 循环（ToolExecutor 分发）
        │               ├── 中间工具调用不可见（Pro 上下文零污染）
        │               └──→ 返回: "审查结论: 3 个问题..."
        │
        └── SKILL.md frontmatter: runAs = "inline"（默认）
                │
                └──→ followUpMessages (system 消息注入 Pro 上下文)
                        │
                        └── Pro 自己读正文 → 亲自执行 → 全过程在会话中
```

### 3.3 内置 Explorer 回退机制

```
SkillLoad("explore")
        │
        ├── .deepseek-code/skills/explore/SKILL.md 存在
        │       └──→ 读取文件，解析 runAs: subagent → 委派 Flash Explorer
        │
        └── 文件不存在
                └──→ skill-load-handler.ts 检测 name === "explore"
                     → 使用内置 EXPLORER_SYSTEM 常量
                     → 委派 Flash Explorer
```

内置 Explorer 还在 `prompt.ts` 的 `getSkillsIndex` 中常驻显示，确保 Pro 始终知道它的存在。

### 3.4 Pro 决策树

```
Pro 接到任务:
│
├── 1 文件, 1-2 行 (拼写/重命名) → edit_file 直接改
├── 1 文件, 3-20 行 → spawn_code_executor (1 file_path)
├── 2-5 文件 → spawn_code_executor × N 并行 (每个 Fixer 1-2 文件)
│
├── 需要先理解代码?
│   ├── 结构性问题 → spawn_explorer
│   └── 3-5 文件且需理解 → Explorer → 审阅 → Fixer
│
├── 6+ 文件, 跨模块重构:
│   Phase 1: 2-3× spawn_explorer 并行探索
│   Phase 2: Pro 汇总, 决定拆分方案
│   Phase 3: N× spawn_code_executor 并行修改
│
└── 使用 Skill:
    └── SkillLoad("code-review") → Skill 自己决定 runAs
```

---

## 四、实现细节

### 4.1 核心函数

| 函数 | 位置 | 职责 | 迭代上限 | 默认模型 |
|---|---|---|---|---|
| `handleCodeExecutorTool` | `code-executor.ts` | Fixer：代码修改 | 12 | `deepseek-v4-flash` |
| `runSkillSubagent` | `code-executor.ts` | 通用子智能体循环（ToolExecutor 分发） | 20 | `deepseek-v4-flash` |
| `handleSpawnExplorerTool` | `code-executor.ts` | Explorer：代码探索 | 20 | `deepseek-v4-flash` |

### 4.2 Skill 注册模式

Skill 只需一个 Markdown 文件，放在两个位置之一：

| 位置 | 作用域 | 示例 |
|---|---|---|
| `~/.agents/skills/<name>/SKILL.md` | 全局（所有项目） | 个人常用 Skill |
| `./.deepseek-code/skills/<name>/SKILL.md` | 项目级（当前项目） | 项目特定约定 |

```yaml
---
name: code-review
description: 代码审查检查清单
runAs: subagent              # 新增：触发子智能体模式
allowed-tools: read_file, grep, glob, gitnexus_query
model: deepseek-v4-flash
max-tool-iters: 12
---

# Skill 正文
...
```

### 4.3 前端显示

| 工具 | UI 标签 | 通知示例 |
|---|---|---|
| `spawn_code_executor` | `[委派执行]` | `[委派执行] Flash 子智能体工作中…` |
| `spawn_explorer` | `[Explorer]` | `[Explorer] Flash 子智能体工作中…` |
| `SkillLoad` (subagent) | `[委派执行]` | `[委派执行] ✓ 完成 · 3.2s · token 8.5K · ¥0.0062` |

通知格式统一：标签 + 状态 + 耗时 + token 数 + 缓存命中率 + 费用 + 节省。

### 4.4 并行安全

```typescript
// executor.ts
private static readonly PARALLEL_SAFE_TOOLS = new Set([
  "spawn_code_executor",  // Fixer 可并行
  "spawn_explorer",       // Explorer 可并行 ← 新增
  "SkillLoad",            // subagent Skill 可并行
  "gitnexus_query", "gitnexus_context", "gitnexus_impact",
  "gitnexus_clusters", "gitnexus_processes",
  // ...
]);
```

并行上限 3（可通过 `REASONIX_PARALLEL_MAX` 环境变量覆写）。

---

## 五、成本分析

### 5.1 单次 Skill 审查

```
场景: SkillLoad("code-review") 审查一次提交

全 Pro (inline, 优化前):
  Skill 正文: 1000 tokens (Pro context)
  文件读取:  6000 tokens (Pro context)
  搜索结果:  2000 tokens (Pro context)
  输出结论:   500 tokens (Pro output)
  ────────────────────────────────────
  Pro input:  9000 × ¥0.025/M = ¥0.00023  (cache-hit)
  Pro output:  500 × ¥6/M     = ¥0.003
  合计: ¥0.00323

Flash Subagent (优化后):
  Flash input:  9000 × ¥0.02/M = ¥0.00018 (cache-hit)
  Flash output:  500 × ¥2/M    = ¥0.001
  Pro input (结论): 500 × ¥0.025/M ≈ ¥0.00001
  合计: ¥0.0012

节省: 63%
```

### 5.2 多 Skill 累积（同一会话）

```
全 Pro:
  code-review: ¥0.0032
  test:        ¥0.008 (bash 输出大)
  review:      ¥0.0025
  合计: ¥0.0137 → Pro 上下文累积 ~8000 tokens 工具结果

Flash Subagent:
  code-review: ¥0.0012
  test:        ¥0.004
  review:      ¥0.001
  合计: ¥0.0062 → Pro 上下文只进 3 条结论
```

### 5.3 Explorer 对比

```
场景: "找出所有调用 addMessage 的地方"

Pro 亲自探索:
  grep × 2 + read_file × 5
  Pro output: ~2000 tokens × ¥6/M = ¥0.012
  Pro input (工具结果累计): ~4000 tokens

Flash Explorer:
  gitnexus_context + gitnexus_query + read_file × 2
  Flash output: ~800 tokens × ¥2/M = ¥0.0016
  Flash input (冷启动): ~10K tokens × ¥1/M = ¥0.01
  Pro input (结论 1 行): ≈ ¥0.0001
  合计: ¥0.0117 (冷启动主导)

Pro 亲自: ¥0.012
Explorer: ¥0.012

成本相近，但 Pro 上下文中少堆积了 4000 tokens 的工具结果。
长期会话（10+ 次探索）中，Explorer 避免的上下文累积带来显著 KV cache 命中率提升。
```

---

## 六、与 DeepSeek Reasonix 的对比

| 维度 | Reasonix | 本项目 |
|---|---|---|
| **Skill 模式** | `runAs: "inline" \| "subagent"` | 同，完全兼容 |
| **内置 Explorer** | `explore` + `verify` 两种 | `explore` 一种（融入 GitNexus 导航） |
| **子智能体工具分发** | `subagent.ts:buildChildRegistry` fork | `runSkillSubagent` + ToolExecutor 动态 import |
| **Skill 作用域** | project / global / builtin | project / global / builtin |
| **Escalation** | `<<<NEEDS_PRO>>>` 标记 + 自动升级 | ❌ 未实现（子智能体仅 Flash） |
| **进展可视化** | `SubagentSink` 事件流 + `SubAgentCard.tsx` | `[Explorer]` / `[委派执行]` UI 通知 |
| **并行子智能体** | ✅ `parallelSafe` 声明 | ✅ `PARALLEL_SAFE_TOOLS` + 上限 3 |
| **子智能体预算提醒** | `budgetParagraph` + `BUDGET_WARN_THRESHOLD` | ❌ 未实现 |
| **复杂度** | ~1500 行 (subagent.ts + skills.ts + SubAgentCard.tsx) | ~700 行 (code-executor.ts + skill-load-handler.ts) |

本项目采用了 Reasonix 的核心思想（Skill → Subagent 映射 + 角色分化），但去掉了 escalation、预算提醒等重型机制，专注于 Explorer + Fixer 两个最核心的 Flash 委派角色。

---

## 七、向后兼容性

| 旧行为 | 新行为 | 兼容性 |
|---|---|---|
| `SkillLoad("code-review")` 正文注入 Pro 上下文 | frontmatter `runAs: subagent` → 委派 Flash | ✅ 不写 runAs 默认 inline |
| `SkillLoad("unknown")` 报错 | 同，但 `explore` 有内置回退 | ✅ |
| `spawn_code_executor` 行为 | 不变，MAX_ITERS: 8 → 12 | ✅ 仅影响超时边界 |
| `spawn_explorer` 不存在 | 新增工具 | ✅ 旧代码不调用即无影响 |
| SKILL.md frontmatter 格式 | 新增 `runAs` / `allowed-tools` / `model` / `max-tool-iters` | ✅ 旧 frontmatter 忽略未知字段 |

---

## 八、未来扩展方向

1. **Budget 提醒机制**：借鉴 Reasonix `BUDGET_WARN_THRESHOLD`——最后 3 轮时在 tool result 末尾追加 `[budget: N 轮后停止]`，引导子智能体加速收尾
2. **Verifier 子智能体**：窄任务验证（8 轮上限），返回 `VERIFIED / NOT VERIFIED / INCONCLUSIVE`
3. **Researcher 子智能体**：web_search + web_fetch + code_read，用于查外部文档
4. **多 Explorer 结果合并**：Pro 委派 3 个 Explorer 并行探索不同模块，自动合并为一份结构化报告
5. **子智能体 Escalation**：连续失败 3+ 次时自动升级为 Pro（借鉴 Reasonix `<<<NEEDS_PRO>>>`）
6. **子智能体流式进度**：类似 Reasonix `SubagentSink`，实时展示 Explorer 的探索阶段（exploring/summarising）
7. **Skill 市场**：`~/.agents/skills/` 社区共享，`deepseek-code skill install <name>` 一键安装

---

## 九、相关文件

| 文件 | 职责 |
|------|------|
| `src/tools/code-executor.ts` | 子智能体核心：`runSkillSubagent` + `handleSpawnExplorerTool` + `EXPLORER_SYSTEM` + `CODE_EXECUTOR_SYSTEM` |
| `src/tools/skill-load-handler.ts` | Skill 加载：frontmatter 解析 + subagent/inline 分支 + 内置 explore 回退 |
| `src/prompt.ts` | 系统提示词：`spawn_explorer` 工具定义 + `EXPLORER_GUIDANCE` + 决策树 + 内置 explore skill |
| `src/session.ts` | 会话管理：`SkillInfo.runAs` 字段 + `spawn_explorer` UI 通知 |
| `src/tools/executor.ts` | 工具注册：`spawn_explorer` handler + 并行安全标记 |
| `.deepseek-code/skills/explore/SKILL.md` | Explorer skill 文件 |
| `.deepseek-code/skills/code-review/SKILL.md` | 代码审查 skill（runAs: subagent） |
| `.deepseek-code/skills/review/SKILL.md` | 变更审查 skill（runAs: subagent） |
| `.deepseek-code/skills/test/SKILL.md` | 测试 skill（runAs: subagent） |
| `.deepseek-code/skills/refactor/SKILL.md` | 重构 skill（runAs: subagent） |
| `.deepseek-code/skills/feature-dev/SKILL.md` | 功能开发 skill（runAs: inline） |

---

## 十、Commit 记录

```
5b9162a feat: Skill subagent 模式 + Explorer 子智能体
```
