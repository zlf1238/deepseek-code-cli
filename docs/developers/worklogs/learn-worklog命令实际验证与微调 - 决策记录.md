# `/learn` `/worklog` 命令实际验证与微调 — 决策记录

对上一轮实现的 `/learn` 和 `/worklog` 命令进行实际执行验证，修复两个细节问题。

---

## 一、问题背景

### 1.1 验证目标

上一轮实现了两个新斜杠命令后，本轮进行端到端验证：

| 验证项 | 命令 | 结果 |
|--------|------|------|
| `/learn` 能否正确执行反思？ | 用户输入 learn 提示文本 | AI 成功回顾对话、识别新模式、追加到 AGENTS.md |
| `/worklog` 能否生成文档？ | 用户输入 worklog 提示文本 | AI 成功读取格式参考、生成文档 |
| 斜杠菜单是否完整显示？ | 终端输入 `/` | 只显示前 8 条，`/learn` `/worklog` 被折叠为 `… 2 more` |

### 1.2 暴露的问题

| # | 问题 | 影响 |
|---|------|------|
| 1 | 斜杠菜单硬编码上限 8，新命令被折叠 | 用户看不到 `/learn` `/worklog` |
| 2 | `/learn` 执行时 edit 对含 Unicode 转义的行匹配失败 | 需回退 Python 操作 |

---

## 二、决策思路

### 2.1 斜杠菜单上限

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 放宽到 12 | `slice(0,8)` → `slice(0,12)` | 一劳永逸，有余量 | 终端行数略微增加 |
| B. 动态计算 | 按终端高度自适应 | 灵活 | 过度设计 |
| C. 保持 8 | 不改 | 零改动 | 新命令始终不可见 |

**选 A**。当前 10 个命令，12 留有 2 个余量，终端完全容纳。

### 2.2 edit 匹配 Unicode 转义失败

`/learn` 执行时需用 edit 追加"速查第 10 条"。old_string 包含 `\\(` `\\)` `\\\"` 等转义序列，edit 工具匹配失败（similarity=1 但 reported "not found"）。

| 方案 | 作用 |
|------|------|
| 直接用 Python `file.writelines` 插入 | 绕过 edit 工具，字节级精确操作 |

**无争议**，唯一的替代方案（反复调整 old_string）已尝试 3 次均失败。

---

## 三、方案设计

### 3.1 斜杠菜单上限

```typescript
// src/ui/PromptInput.tsx 第862、869行
// 改前
{slashMenu.slice(0, 8).map(...)}
{slashMenu.length > 8 ? <Text dimColor>… {slashMenu.length - 8} more</Text> : null}

// 改后
{slashMenu.slice(0, 12).map(...)}
{slashMenu.length > 12 ? <Text dimColor>… {slashMenu.length - 12} more</Text> : null}
```

### 3.2 edit 回退 Python 操作

```python
# 无法用 edit 工具时，直接操作文件
with open('AGENTS.md', 'r', encoding='utf-8') as f:
    lines = f.readlines()
lines.insert(149, new_line)
with open('AGENTS.md', 'w', encoding='utf-8') as f:
    f.writelines(lines)
```

---

## 四、文件修改统计

```
 src/ui/PromptInput.tsx       | ±2 行 (slice 上限 8→12)
 AGENTS.md                    | +13 行 (新增 1.2 节 + 速查第10条)
 docs/developers/worklogs/    | +1 文件 (AI自我反思与决策记录功能 - 决策记录.md)
                              | +1 文件 (本文档)
 4 files changed
```

| 文件 | 改动 |
|------|------|
| `src/ui/PromptInput.tsx` | `slashMenu.slice(0, 8)` → `slice(0, 12)`，两处 |
| `AGENTS.md` | 新增 1.2 节（Write 工具 Unicode 退化）+ 速查第 10 条 |
| `docs/developers/worklogs/AI自我反思与决策记录功能 - 决策记录.md` | `/learn` `/worklog` 设计决策文档 |
| 本文档 | 验证与微调记录 |

---

## 五、相关文件

| 文件 | 职责 |
|------|------|
| `src/ui/slashCommands.ts` | 斜杠命令类型与列表 |
| `src/ui/PromptInput.tsx` | 斜杠菜单渲染 + 命令处理 |
| `AGENTS.md` | `/learn` 输出目标 |
| `docs/developers/worklogs/` | `/worklog` 输出目录 |
