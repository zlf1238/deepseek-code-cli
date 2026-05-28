# 项目规则

> 通用规则（工具策略、停止条件、注释规范等）见 `~/.deepseek-code/AGENTS.md`，与项目规则合并注入 system prompt。

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
