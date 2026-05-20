# Explorer 智能体优化设计方案

> 决策日期：2025-07-17
> 设计对象：Explorer 子智能体（`spawn_explorer`）+ Fixer 子智能体（`spawn_code_executor`）
> 变更范围：P0（关键）/ P1（高优先级）/ P2（优化）

---

## 一、背景

Explorer 是 deepseek-code-cli 中的只读代码库探索子智能体，运行在 `deepseek-v4-flash` 模型上，通过 GitNexus 知识图谱导航替代传统的盲目 grep+逐文件阅读。Fixer 是代码修改子智能体，与 Explorer 共享 `runSkillSubagent` 核心循环。

审查发现 **34 个设计问题**（2 CRIT、5 HIGH、9 MEDIUM、5 LOW），分三个优先级修复。

---

## 二、修改文件清单

| 文件 | P0 | P1 | P2 | 总计 |
|------|:--:|:--:|:--:|:----:|
| `src/tools/code-executor.ts` | ✓ | ✓ | ✓ | 核心 |
| `src/tools/skill-load-handler.ts` | ✓ | — | ✓ | 回退 |
| `src/prompt.ts` | — | ✓ | — | 指引 |
| `.deepseek-code/skills/explore/SKILL.md` | — | ✓ | — | 同步 |

---

## 三、P0：关键修复

### 3.1 消除 `runSkillSubagent` 硬编码名称（CRIT）

**问题**：`runSkillSubagent` 在 6 个返回路径中硬编码 `name: "SkillLoad"`，3 个调用方各自用 `{ ...result, name: "X" }` 覆盖。双层覆盖在重构时极易遗漏，导致 UI 通知和 usage 追踪异常。

**方案**：给 `runSkillSubagent` 增加可选 `name` 参数（默认 `"SkillLoad"` 保持向后兼容），6 处返回路径统一使用该参数。3 个调用方传入正确名称，去掉外层覆盖。

```
runSkillSubagent(context, prompt, task, model, tools, iters, stop, name)

调用方传入:
  handleSpawnExplorerTool     → "spawn_explorer"
  skill-load-handler (内置)   → "SkillLoad"
  skill-load-handler (SKILL)  → "SkillLoad"
```

### 3.2 `allowed_tools` 空数组守卫（CRIT）

**问题**：Pro 传 `allowed_tools: []` 时 Explorer 零工具启动立即失败；传 `["read_file"]` 剥夺 GitNexus 能力。

**方案**：在 `handleSpawnExplorerTool` 中增加三层守卫：
1. 空数组 → 回退默认集（`undefined`）
2. 缺 GitNexus 工具 → 合并 `EXPLORER_MIN_TOOLS`
3. 缺 `read_file` → 合并 `EXPLORER_MIN_TOOLS`

### 3.3 `max_iters` 上限钳位（HIGH）

**问题**：Pro 可传 `max_iters: 9999` 导致失控 API 成本。

**方案**：`Math.max(1, Math.min(rawMaxIters, 32))`，钳位到 `[1, 32]`。

---

## 四、P1：高优先级修复

### 4.1 EXPLORER_SYSTEM 与 SKILL.md 同步标记（HIGH）

**问题**：两处维护几乎相同的指令内容（`EXPLORER_SYSTEM` 常量 + `SKILL.md` 文件），修改时极易不同步。

**方案**：
- `SKILL.md` 顶部增加 `<!-- @keep-in-sync: must mirror EXPLORER_SYSTEM in src/tools/code-executor.ts -->` 标记
- 未来可考虑构建时校验脚本

### 4.2 Explorer 只读强制（HIGH）

**问题**：`EXPLORER_SYSTEM` 声明为只读，但若 Pro 传入包含写工具的 `allowed_tools`，Explorer 可写入文件。

**方案**：在 `handleSpawnExplorerTool` 尾部增加写工具黑名单，强制过滤：

```
const WRITE_TOOLS = new Set(["edit_file", "write_file", "multi_edit", "bash"]);
if (allowedTools) {
  allowedTools = allowedTools.filter((t) => !WRITE_TOOLS.has(t));
}
```

### 4.3 GitNexus 故障转移指令（HIGH）

**问题**：`EXPLORER_SYSTEM` 指示 GitNexus 优先，但未说明 GitNexus 返回空/错误时如何处理。对尚未索引的项目，Explorer 会静默失败。

**方案**：`EXPLORER_SYSTEM` 和 `SKILL.md` 同步追加：

> If GitNexus tools return empty results or errors (project may not be indexed yet), fall back to grep + read_file to explore directly — but stay focused on the task.

### 4.4 EXPLORER_GUIDANCE 验证与重试策略（MEDIUM）

**问题**：Pro 的 `EXPLORER_GUIDANCE` 只告诉**何时**委派，缺少**验证结果**和**失败处理**的指导。

**方案**：扩展 `EXPLORER_GUIDANCE`，新增两段：

**Verify Explorer results**：
- 信任但验证 — Explorer 可能漏掉间接调用者
- 交叉验证 1-2 个关键文件
- 两个 Explorer 结果冲突时深入调查

**On failure**（按 failureCode 分类）：
- `NOT_FOUND / AMBIGUOUS` → 重新读取后收紧范围重试
- `API_ERROR` → 重试一次（瞬态）；持续失败回退到直接探索
- `TIMEOUT / SCOPE_EXCEEDED` → 拆分为更小的单问题 Explorer

---

## 五、P2：优化修复

### 5.1 Fixer 开放 multi_edit 工具

**问题**：Flash Fixer 只有 `read_file` + `edit_file` + `write_file`，每次 API 调用只能改一处。8 处编辑 → 理想 5 轮，实际 12 轮不够。

**方案**：
- 默认工具集增加 `"multi_edit"`
- `getSubagentTools` 新增 `multi_edit` JSON Schema 定义
- `CODE_EXECUTOR_SYSTEM` rule #2 追加：跨文件修改优先用 `multi_edit`

**效果**：之前的 8 处 P0 修改本可一次 API 调用完成，不再需要 12 轮。

### 5.2 ToolExecutor 单例缓存

**问题**：每次 Explorer 调用都创建新 `ToolExecutor` 实例（注册 ~25 个 handler），对 1-2 轮的轻量探索是浪费。

**方案**：模块级惰性单例：

```
let _cachedToolExecutor: ... | null = null;

// 在 runSkillSubagent 中:
if (!_cachedToolExecutor) {
  const { ToolExecutor } = await import("./executor");
  _cachedToolExecutor = new ToolExecutor(context.projectRoot, context.createOpenAIClient);
}
const toolExecutor = _cachedToolExecutor;
```

### 5.3 Explorer 置信度标记

**问题**：Pro 无法区分 Explorer 结果的可信度，只能盲信。

**方案**：`EXPLORER_SYSTEM` 输出格式增加三级置信度：

| 标记 | 含义 |
|------|------|
| `[confident]` | GitNexus 返回明确结果，已用 read_file 交叉验证 |
| `[partial]` | 找到部分证据但可能不完整（如仅直接调用者） |
| `[uncertain]` | GitNexus 失败或返回空，仅基于 grep/read_file |

### 5.4 自适应提前终止

**问题**："Stop early" 完全依赖模型自律，无程序化终止机制。

**方案**：在主循环中跟踪连续搜索行为。当连续 3 轮仅使用搜索类工具（`read_file / grep / glob / search_files / directory_tree / get_file_info`）且无实质性进展时，自动提前终止并返回已有结果。

### 5.5 SKILL.md 损坏回退

**问题**：SKILL.md 存在但 gray-matter 解析失败时，落入通用错误而不会回退到内置 `EXPLORER_SYSTEM`。

**方案**：frontmatter 解析包裹 try-catch。解析失败时：
- explore skill → 使用 `EXPLORER_SYSTEM` 回退，走 subagent 模式
- 其他 skill → 返回明确错误（`AMBIGUOUS`）

### 5.6 calculateSubagentCost 计算修复

**问题**：`prompt - hit - miss` 在部分 API 实现中可能为负，`Math.max(0, ...)` 吞掉异常。

**方案**：改为 `prompt - (hit + miss)`，加注释说明。

---

## 六、执行记录

| 优先级 | 修改项 | 执行方式 | 结果 |
|--------|--------|---------|------|
| P0-1 | runSkillSubagent 消除硬编码 name | Pro `multi_edit` | ✅ |
| P0-2 | allowed_tools 空数组守卫 | Pro `multi_edit` | ✅ |
| P0-3 | max_iters 钳位 | Pro `multi_edit` | ✅ |
| P1-1~4 | 同步标记/只读强制/故障转移/指引扩展 | Pro `multi_edit` | ✅ |
| P2-1 | Fixer 开放 multi_edit | Pro `multi_edit` | ✅ |
| P2-2~4 | ToolExecutor 缓存/置信度/提前终止 | Flash Fixer（4/4 完成但超时） | ⚠️ |
| P2-5~6 | SKILL.md 回退/费用计算修复 | Flash Fixer + Pro 修复作用域 bug | ⚠️ |

### Flash Fixer 超时分析

两次 Flash Fixer 超时（P0、P2-2~4）根因一致：

1. **12 轮上限 vs 多编辑任务**：4-8 处独立编辑，每次 API 调用仅改 1 处，容错余量太小
2. **无 `multi_edit` 工具**（P2-1 之后才开放）：若 Fixer 有 `multi_edit`，多处编辑可一次调用完成
3. **无 `tsc` 自检**：Fixer 写完后无法验证编译，Pro 需事后修复（如 P2-5 的 `frontmatter` 作用域 bug）

**已采取缓解措施**：Fixer 默认工具集增加 `multi_edit`（P2-1），未来应考虑暴露 `tsc --noEmit` 给 Fixer。

---

## 七、影响评估

| 维度 | 评估 |
|------|------|
| **安全性** | ↑ Explorer 只读强制（写工具黑名单）、max_iters 钳位防止成本失控 |
| **可靠性** | ↑ GitNexus 故障转移、SKILL.md 损坏回退、自适应终止防止空转 |
| **可维护性** | ↑ 硬编码名称消除、SKILL.md 同步标记、单例缓存减少创建开销 |
| **协作效率** | ↑ Pro 获得置信度标记和验证策略、Fixer 获得 multi_edit 批处理能力 |
| **成本** | ↓ 自适应终止避免无意义探索、单例缓存减少重复初始化 |
| **风险** | 低 — 所有修改为纯逻辑层面的守卫/增强，未改变核心循环行为 |
