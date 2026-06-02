# 实战经验手册 · 归档

> 此文件保存已从 AGENTS.md 中清理的规则原文，供复盘参考。
> 归档理由：要么是场景已过不会再犯，要么已固化为习惯不再需要手记。

---

## 项目特有（原项目 AGENTS.md）

### 已归档

**CLI 退出时机不当会导致终端残留在 raw mode**
- 退出 CLI 时应让 Ink 的 waitUntilExit() 自然接管流程，`process.exit()` 应在 waitUntilExit().then() 中执行。
- 手动 `exit()` + `process.exit(0)` 会抢在 Ink 退出 raw mode 前杀进程，终端看似卡死。

**busy 状态下拦截用户退出指令应给反馈**
- PromptInput 中 `if (busy) return` 导致 Ctrl+D 被静默丢弃，用户得不到任何反馈。
- 拦截时应给出提示（如"正在处理中，无法退出"），而非无声忽略。

**终端物理视口不可控 — 写入超过屏幕高度后视口必然停在底部**
- 现象：跳转到 #3 后视口停在底部。
- 原因：终端写入超过屏幕高度的内容后，视口必然停在底部。没有任何标准 ANSI 序列能可靠地将物理视口"拉"回顶部——这是终端模拟器的硬约束。
- 解决：控制写入行数不超过屏幕高度（视口自然在顶部），而非"写完后把视口拽上去"。

**跨函数传递数组索引时确保"数组上下文"一致**
- 现象：`renderQuestionList` 用 `allMessages` 的索引，`loadMessagesFromSession` 用 `filtered` 做 `slice`，索引错位。
- 解决：跨函数传递索引时确保两个函数操作的是同一个数据源的索引。

**基类新增属性要留意结构兼容性 — 用 `?` 可选属性**
- 现象：`Container` 添加 `maxVisibleLines` 后，`new Box()` 报错属性缺失。
- 原因：`Box implements Component`（非 extends Container）。
- 解决：基类添加非所有子类都必须实现的新属性时，使用可选属性 `?`。

**截断逻辑统一维度 — 字符数 vs 可见宽度**
- 现象：`formatSessionTitle` 按字符数截断 + `truncateToWidth` 按可见宽度二次截断，中英文列宽不同。
- 解决：统一截断策略，要么都用字符数 + 空格填充，要么都用可见宽度。

**`maxPrimaryColumnWidth` 过大不会导致"右侧空隙"问题**
- 原因：`primaryColumnWidth = clamp(最宽内容宽度, min, max)`，`max` 只是上限。
- 解决：将 description 靠右对齐（用空格填充到行尾）而非加大 `maxPrimaryColumnWidth`。

**迁移 Ui 框架时先对照原版功能清单逐项对齐**
- 核心根因：缺乏系统的原版对照清单。每次用户反馈都是"原来的 Ink 版本有 XX，现在怎么没有了"。
- 教训：迁移完成后用原版逐项对比功能清单，而非等用户逐个指出。
- 具体缺失项：斜杠命令菜单、增量 token 统计、AI 响应即时刷新、状态行延迟、双 ● 前缀、ModeBar 位置等。

### 已自动化（待工具改造）

**Python 脚本修改文件后必须验证**
- 现象：脚本输出 `OK` 但文件实际未被修改。
- 解决：Python 脚本修改文件后，立即用 `grep` 或 `sed` 验证改动是否真的写入。

**操作文件前先确认缩进格式**
- 现象：多次因缩进（tab vs 空格、tab 个数）不匹配导致 old string 找不到。
- 解决：操作前用 `cat -A` 确认目标文件的缩进格式。

**multi_edit 是批量修改的首选工具**
- 多文件多处修改用 `multi_edit` 一次提交，比逐个 `edit` 高效。
- `multi_edit` 写入后自动更新文件状态，后续操作不受影响。

---

## 通用（原全局 AGENTS.md）

### 已归档

**handle_read 可并行**
- 已知行号时，同一文件的不同区域多段 handle_read 并行发出，减少 RTT。

**job_output 循环防护**
- 同一 jobId 连续 3 次触发拦截。用 list_jobs 代替轮询；快速任务直接用 bash 同步执行。

**run_background 前验证目标存在**
- 用 glob/ls 确认文件存在；30 秒无输出应怀疑异常；用 list_jobs 而非连续 job_output 查状态。

**停止探索（The Stopping Problem）**
- 理解型问题 ≤3-4 个文件；每读完自问"够了吗？"；发现"顺便"任务立刻停止。
- （已由 AGENTS.md 中"停止条件"章节完整覆盖）

**复杂替换用 Python /tmp/ 脚本**
- edit/multi_edit 无法处理时，写 Python 脚本到 /tmp/ 执行，完事后 rm -f /tmp/fix_*.py。

**需求清单锁定本轮范围**
- "开始实施"时用 todo_write 列出本轮子清单请用户确认；一轮只做一个模块。

**大文件 read 分场景**
- <300行→完整 read；>500行需修改→grep 定位+并行 offset+edit 用 snippet_id；纯探索→够了就停。

**edit 后缓存立即失效**
- 修改前完整 read → edit → 改后立即完整 read 重建缓存。后续用 handle_read 而非 read。

**批量重编号用 Python，不用 sed -e**
- sed -e 链式替换会连锁匹配。用 Python 一次遍历，或 ≤5 条用 multi_edit 逐条精确替换。

**pi TUI 流式表格渲染三层防御**
- 列宽缓存（tableWidthCache）确保列宽只扩不缩；50ms 防抖降帧率；光标绝对定位（CSI n;1H）替代相对移动消除漂移。

**代码库碎片化程度决定 token 消耗**
- 项目总行数不重要，文件数才是关键。86 个文件项目中理解功能需 2-3 个文件，1304 个文件项目中需 5-8 个。

**edit 失败一次就切 Python**
- 用同一个 old_string 重试 edit 通常是字符编码/空格差异，不会突然匹配。失败即写 Python 脚本精确操作。

**批量修改 text 前先 grep 看全貌**
- 用 regex 批量改 test mock 时，先 `grep -n pattern` 看所有变体，再一次性写完整的替换脚本。
