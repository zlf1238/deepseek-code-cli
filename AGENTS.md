<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **deepseek-code** (2696 symbols, 5143 relationships, 227 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| 工具 | 用途 |
|------|------|
| `gitnexus_context({name: "符号名"})` | 符号 360 度视图：调用者、被调用者、参与的流程 |
| `gitnexus_clusters({})` | 列出代码库所有功能聚类及内聚度 |
| `gitnexus_processes({})` | 列出所有执行流 |
| `gitnexus_processes({process: "名称"})` | step-by-step 执行链路追踪 |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.deepseek-code/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.deepseek-code/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.deepseek-code/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.deepseek-code/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.deepseek-code/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.deepseek-code/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

---

# 项目规则

> 通用规则（工具策略、停止条件、注释规范等）见 `~/.deepseek-code/AGENTS.md`，与项目规则合并注入 system prompt。

## rtk 环境

- 用绝对路径：`/usr/bin/find`、`/root/.nvm/versions/node/v22.22.2/bin/node` 等
- `spawn`/`spawnSync` 不经过 shell，不要转义括号/引号（`\(` → `(`）

## 测试

```
/root/.nvm/versions/node/v22.22.2/bin/node --import tsx --test src/tests/xxx.test.ts
```

## 项目特定禁止

- 索引过期时反复 `gitnexus_query`

---

# 项目实战经验

> 通用实战经验（#1-#14, #17-#18）见 `~/.deepseek-code/AGENTS.md`。

## 1. Ink Box 的 marginBottom/marginTop 会额外占用终端行 — 布局计算必须逐项累加

- **现象**：`/resume` 后 SessionList 正好占满终端时，旧对话内容残留在屏幕上；删除几个会话后 bug 消失。之前已有人尝试过两个方案（改 `clearTerminal` 写 stderr、revert 恢复原版）均未解决。
- **原因**：
  1. `OVERHEAD_LINES=4` 漏算了 `<Box marginBottom={1}>` 和 `<Box marginTop={1}>` 各产生的 1 个空行，实际固定 overhead 为 5 行。`maxVisible = rows - 5`，总行数 = 5 + (rows-5) + 1(隐藏提示) = rows + 1，**超出终端 1 行**→ 终端被迫滚动 → `clearTerminal` 清掉的内容被滚回屏幕。
  2. `<Static>` 组件在 `session-list` 视图下也参与渲染，Ink 的永久输出与 `clearTerminal()`（直接写 stdout，绕过 Ink 虚拟屏幕）产生竞态。
- **解决**：
  1. 修正 `OVERHEAD_LINES` 为 6（实际 5 行 + 1 行安全余量），使 `maxVisible = rows - 7`，总行数 = rows - 2，不再溢出。
  2. `<Static>` 加 `view === "chat"` 条件包裹，`session-list` 视图下完全卸载。
- **排查关键**：用户精确描述"占满屏幕时触发"→ 立刻怀疑 off-by-one 边界溢出 → 手工逐行累加渲染树中的 Box/margin 行数 → 确认溢出 1 行。

## 2. Ink 终端渲染：`clearTerminal()` 绕过 Ink 虚拟屏幕时存在竞态

- **现象**：`clearTerminal()` 通过 `directTerminalWrite` 直接写 stdout，但 Ink 4 维护自己的虚拟屏幕状态。清屏后 Ink 不知道屏幕已空，可能不在已清空区域输出新内容，或被 `Static` 的永久输出覆盖。
- **原因**：`directTerminalWrite` 和 Ink 的 `stdout.write` 共享同一个 fd，两者的输出在 ConPTY 缓冲区中按时间序混合，但 Ink 的虚拟屏幕状态不与物理终端同步。
- **解决**：最可靠的策略是**在视图切换时完全卸载 `Static` 组件**（用条件渲染），而非仅依赖 `clearTerminal`。如果需要 `clearTerminal` + 重新渲染的组合，确保两者之间有足够的同步点（如 `staticKey` 递增）。
