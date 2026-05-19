<!-- gitnexus:start -->
# GitNexus — 代码智能

本项目由 GitNexus 索引为 **deepseek-code**（2579 个符号，4945 个关系，220 条执行流）。使用 GitNexus MCP 工具来理解代码、评估影响并安全导航。

> 如果任意 GitNexus 工具提示索引已过期，请先在终端中运行 `npx gitnexus analyze`。

## 必须遵守

- **修改任意符号前必须运行影响分析。** 在修改函数、类或方法之前，运行 `gitnexus_impact({target: "symbolName", direction: "upstream"})` 并向用户报告影响范围（直接调用者、受影响的流程、风险等级）。
- **提交前必须运行 `gitnexus_detect_changes()`** 以验证你的修改只影响了预期的符号和执行流。
- **如果影响分析返回 HIGH 或 CRITICAL 风险，必须在继续编辑之前警告用户。**
- 探索不熟悉的代码时，使用 `gitnexus_query({query: "概念"})` 查找执行流，而不是用 grep 搜索。它返回按流程分组、按相关性排序的结果。
- 当需要某个特定符号的完整上下文（调用者、被调用者、参与的执行流）时，使用 `gitnexus_context({name: "符号名称"})`。

## 禁止事项

- 未经 `gitnexus_impact` 分析，绝不编辑函数、类或方法。
- 绝不忽略影响分析中的 HIGH 或 CRITICAL 风险警告。
- 绝不使用查找替换来重命名符号——使用理解调用图的 `gitnexus_rename`。
- 未经 `gitnexus_detect_changes()` 检查影响范围，绝不提交。

## 资源

| 资源 | 用途 |
|----------|---------|
| `gitnexus://repo/deepseek-code/context` | 代码库概览，检查索引新鲜度 |
| `gitnexus://repo/deepseek-code/clusters` | 所有功能领域 |
| `gitnexus://repo/deepseek-code/processes` | 所有执行流 |
| `gitnexus://repo/deepseek-code/process/{name}` | 逐步执行追踪 |

## CLI

| 任务 | 阅读此技能文件 |
|------|---------------------|
| 了解架构 / "X 是如何工作的？" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| 影响范围 / "修改 X 会破坏什么？" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| 追踪 Bug / "X 为什么失败？" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| 重命名 / 提取 / 拆分 / 重构 | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| 工具、资源、Schema 参考 | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| 索引、状态、清理、Wiki CLI 命令 | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
