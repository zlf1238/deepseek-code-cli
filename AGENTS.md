# 项目规则

> 通用规则（工具策略、停止条件、注释规范等）见 `~/.deepseek-code/AGENTS.md`，与项目规则合并注入 system prompt。

## 测试

```
/root/.nvm/versions/node/v22.22.2/bin/node --import tsx --test src/tests/xxx.test.ts
```

## 提交规范

- 所有 git commit message 必须使用中文书写。

## 项目特定禁止

- 索引过期时反复 `gitnexus_query`

## 实战经验手册

> 核心教训，每条一行规则。如需完整案例，格式：现象 → 原因 → 解决。

### 1. 搜索覆盖要全面
- 全局重命名符号/文件后，在整个 `src/` 下搜索旧符号名，确保无残留引用。
- 仅搜索 `src/ui/` 可能遗漏入口文件（如 `cli.tsx`）。

### 2. 分析问题先分"设计行为"与"代码缺陷"
- 出现错误先追问：这是有意的安全守卫还是真正的 bug？
- 追踪完整调用链（报错点 → 上层调用 → 参数来源）找到根因。

### 3. 复用已有工具函数
- 修复前先 grep 项目中是否已有类似功能的函数，避免重复造轮子。
- 已有函数未被所有应该使用它的地方调用时，补充调用而非另起炉灶。

### 4. multi_edit 是批量修改的首选工具
- 多文件多处修改用 `multi_edit` 一次提交，比逐个 `edit` 高效。
- `multi_edit` 写入后自动更新文件状态，后续操作不受影响。

### 5. 理解参数传递链
- 工具调用失败时，阅读底层库的 `resolveRepo`/`callTool` 等核心方法，理解 MCP 参数传递机制。
- 很多"环境配置类"错误的根因是缺少某个必需的参数。

### 6. 用户表述模糊时先确认，不急于展开多方案
- "某次对话"可能指"某个 Session"或"会话中的某条提问"。有歧义时用一句话确认理解后再展开方案。
- 宁可多花一轮确认，也不要花两轮纠偏。

### 7. 选定方案后先描述用户体验闭环，再实现
- 用户说"方案 A"不等于理解方案 A 的副作用。实现前描述完整体验："选了这个方案后，你会看到 XXX，需要额外操作 YYY 才能 ZZZ。"
- 确保用户在知情前提下决策——尤其当方案有功能性取舍（如截断 vs 完整渲染）。

### 8. `run_background` 任务未出结果前不回复"完成"
- run_background 提交的任务未产生输出前，不应给出"已修复"式的终结性回复。
- 连续 3 次 job_output 触发重复循环防护后，应切到 list_jobs 查看任务状态，而非跳过等待。
- 提交 git 前必须确认所有相关测试完成，且测试失败是预先存在的（可 git stash 对照验证）或已修复。

### 9. CLI 退出时机不当会导致终端残留在 raw mode
- 退出 CLI 时应让 Ink 的 waitUntilExit() 自然接管流程，`process.exit()` 应在 waitUntilExit().then() 中执行。
- 手动 `exit()` + `process.exit(0)` 会抢在 Ink 退出 raw mode 前杀进程，终端看似卡死。

### 10. busy 状态下拦截用户退出指令应给反馈
- PromptInput 中 `if (busy) return` 导致 Ctrl+D 被静默丢弃，用户得不到任何反馈。
- 拦截时应给出提示（如"正在处理中，无法退出"），而非无声忽略。

### 11. 终端物理视口不可控 — 写入超过屏幕高度后视口必然停在底部
- **现象**：跳转到 #3 后视口停在底部，尝试了 `\x1b[H`、`\x1b[A`、`\x1b[T`、`previousViewportTop`、`maxVisibleLines` 等均无效。
- **原因**：终端写入超过屏幕高度的内容后，视口必然停在底部。没有任何标准 ANSI 序列能可靠地将物理视口"拉"回顶部——这是终端模拟器的硬约束。
- **解决**：如果需求是"跳转后看到目标内容"，方案应是**控制写入行数不超过屏幕高度**（视口自然在顶部），而非"写完后把视口拽上去"。
- **关联**：TUI 框架的 `previousViewportTop` 只是差异渲染的偏移计数器，不控制物理终端视口。

### 12. 跨函数传递数组索引时确保"数组上下文"一致
- **现象**：`renderQuestionList` 用 `allMessages` 的索引记录 `messageIndex`，`loadMessagesFromSession` 用 `filtered`（可见消息子集）做 `slice`，索引错位导致选中第一条提问跳到了后面。
- **原因**：`allMessages` 包含 system 等不可见消息，而 `filtered` 只包含可见消息，两个数组长度不同。
- **解决**：跨函数传递索引时确保两个函数操作的是同一个数据源的索引。

### 13. 基类新增属性要留意结构兼容性 — 用 `?` 可选属性
- **现象**：在 `Container` 中添加 `maxVisibleLines` 后，`new Box()` 报错 `Property 'maxVisibleLines' is missing`。
- **原因**：`Box implements Component`（非 extends Container），TypeScript 结构兼容性检查发现新属性缺失。
- **解决**：在基类添加非所有子类都必须实现的新属性时，使用可选属性 `?`。

### 14. 截断逻辑统一维度 — 字符数 vs 可见宽度
- **现象**：`formatSessionTitle` 按字符数截断 + SelectList 的 `truncateToWidth` 按可见宽度二次截断，中英文列宽不同导致视觉不一致（同样 50 字符，纯中文占 100 列，纯英文占 50 列）。
- **解决**：统一截断策略，要么都用字符数 + 空格填充对齐，要么都用可见宽度。混用会导致不可预期的截断行为。

### 15. Python 脚本修改文件后必须验证
- **现象**：`fix_uniform_width.py` 输出 `OK: import` + `OK: applyFilter`，但文件实际未被修改。
- **解决**：Python 脚本修改文件后，立即用 `grep` 或 `sed` 验证改动是否真的写入文件。

### 16. 操作文件前先确认缩进格式
- **现象**：多次 Python 脚本因缩进（tab vs 空格、tab 个数）不匹配导致 old string 找不到。
- **解决**：操作前用 `cat -A` 确认目标文件的缩进格式。tui.ts 用 tab，PiApp.ts/AGENTS.md 用 2 空格/4 空格。

### 17. `maxPrimaryColumnWidth` 过大不会导致"右侧空隙"问题
- **现象**：认为将 `maxPrimaryColumnWidth` 从 0.8 调到 0.9 能填满列表右侧空白，实际无效。
- **原因**：`primaryColumnWidth = clamp(最宽内容宽度, min, max)`，内容宽度由实际内容决定，`max` 只是上限。如果最长内容只有 40 字符，`max=80` 和 `max=999` 效果一样。
- **解决**："右侧空隙"是 SelectList 布局机制导致的（主列内容短 + 描述列在右侧），解决方式是将 description 靠右对齐（用空格填充到行尾）而非加大 `maxPrimaryColumnWidth`。

### 18. 迁移 Ui 框架时先对照原版功能清单逐项对齐

**背景**：将 Ink(React) 终端渲染引擎迁移到自研 pi TUI 差分渲染引擎（6000+ 行）。

| 问题 | 根因 | 教训 |
|------|------|------|
| 斜杠命令菜单完全缺失 | `handleSlashChange` 留为空桩 | 核心交互入口应在骨架阶段完整实现，不等"后续迭代" |
| 状态行缺少耗时/增量 token | 只迁移了 `buildStatusLine`（累计），未迁 `buildCompletionSummary`（增量） | 迁移后对照原版功能清单逐项对齐，特别注意"增量 vs 累计"类数据 |
| AI 响应不即时显示 | `renderChat()` 后未调 `requestRender()` | 含虚拟屏幕的渲染引擎，每次状态变更后都需刷新物理终端 |
| 状态行延迟出现 | `renderChat()` 在 `setBusy(true)` 之前调用 | 先设状态再渲染，保持"setXxx + render"的顺序一致性 |
| 步骤指示器双 ● 前缀 | 调用方和渲染层都加了 `●` | 角色前缀由渲染层统一负责，上层只传纯内容 |
| ModeBar 位置和 idle 内容不对 | 渲染在顶部而非底部，idle 显示了多余文本 | 布局结构优先对齐原版，再做优化 |
| 底部冗余状态栏 | 凭感觉添加了 Ink 没有的 model/thinking/verbose 行 | 不添加原版没有的功能，用户以原版为基准对比 |

**核心根因**：缺乏系统的原版对照清单。每次用户反馈都是"原来的 Ink 版本有 XX，现在怎么没有了"。应当在迁移完成后用原版逐项对比功能清单，而非等用户逐个指出。

