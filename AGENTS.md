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

# 规则

## 工具策略
- `grep` 返回空 → 立刻 `bash grep`；`directory_tree` 返回空 → 立刻 `bash ls/find`
- 大文件(>500行)：先 `get_file_info` 再精准 `offset/limit`
- 同一文件多处修改：`multi_edit` 一次提交
- 探索子系统：使用 `gitnexus_*` 工具或 grep+read 自行探索

## 停止条件（与工具策略同等重要，两者形成闭环）
- 回答理解型问题时，读取超过 3 个文件后必须自问"已有信息足够回答用户问题了吗？"
- 如果当前信息覆盖了用户问题的所有要点 → 停止探索，开始回答
- 持续探索不回答，比回答不完整但能追问更差
- 回答了一个问题后，不要再主动做对比分析、统计查询——等用户追问
- todo_write 清空 = 任务完成 = 停止所有工具调用，不要追加新条目

## rtk 环境
- 用绝对路径：`/usr/bin/find`、`/root/.nvm/versions/node/v22.22.2/bin/node` 等
- `spawn`/`spawnSync` 不经过 shell，不要转义括号/引号（`\(` → `(`）

## 测试
```
/root/.nvm/versions/node/v22.22.2/bin/node --import tsx --test src/tests/xxx.test.ts
```

## 注释
- 写代码（JS/TS/Shell 等）必须使用中文注释
- 发现已有代码中的英文注释，自动改为中文注释
- JSDoc / TSDoc 描述也使用中文

## 禁止
- 写 JS/TS 源码时使用中文引号 `""` → 用《》
- 索引过期时反复 `gitnexus_query`
- 修改代码后不跑相关测试
- 写代码时使用英文注释

---

# 实战经验手册

> 每次会话中的工具使用失败、策略失误、效率低下等教训，总结为条目追加于此。格式：现象 → 原因 → 解决。

## 1. `grep` 搜索单文件时返回空 — `-rn` 缺少 `-H` 标志（已修复，已验证）

- **现象**：`grep` 搜索单个文件路径始终返回 `(no matches)`，但搜索目录时可以命中同一文件。`bash grep` 命令行直接执行正常。
- **原因**：`buildGrepArgs` 使用 `grep -rn` 但缺少 `-H`。当目标为单个文件时，`grep` 不在输出中写文件名前缀（因为只有一个文件），导致 `parseGrepOutput` 的正则 `/^([^:]+):(\d+):(.*)$/`（期望 `file:line:content` 格式）匹配失败，所有结果被丢弃。
- **解决**：将 `-rn` 改为 `-rnH`，强制 grep 始终输出文件名前缀。一行修复。
- **排查过程**（2025-07-14）：先怀疑是 include 默认值排除了 .ts，后通过对比目录搜索 vs 单文件搜索的输出差异定位到 `-H` 缺失。阅读 `parseGrepOutput` 正则确认根因。
- **验证**（2025-07-15）：单文件搜索 `models.generated.ts` 命中 113 条结果，确认修复生效。内置 `grep` 可放心用于单文件搜索。

## 2. `grep` 返回空后不要换模式重试，一次失败就切

- **现象**：`grep "deepseek"` 返回空 → 换成 `grep "deep.?seek"` 仍空 → 换成 `grep "provider:"` 仍空，连试3次才切 `bash grep`。
- **原因**：AGENTS.md 规则写了"`grep` 返回空 → 立刻 `bash grep`"，但"立刻"在实践中被理解成了"确认一下不是 pattern 写法问题"，导致浪费2次额外调用。
- **解决**：内置 `grep` 返回 `(no matches)` 一次就立刻切 `bash grep`。空结果本身是明确的失败信号，无需换 pattern 二次确认。
- **补充**：条目 #1 的 `-H` bug 修复后，内置 `grep` 单文件搜索已可靠，大部分场景无需回退。但仍遵循"一次空就切"原则以防其他未知边界情况。

## 3. 已知行号时，多个 `handle_read` 可并行

- **现象**：查价格时，先用 `bash grep -n` 获得了所有 deepseek 模型的行号，之后串行调用了 9 次 `handle_read` 逐段读取。
- **原因**：习惯性串行，未意识到 `handle_read` 之间无依赖关系（读取的是同一文件的不同区域）。
- **解决**：如果已通过 `grep -n` 或类似方式知道所有目标行号范围，多段 `handle_read` 并行调用，减少 RTT 延迟。一次性发出所有读取请求，再统一汇总。

## 4. `job_output` 不要连续 3 次相同调用 — 会触发重复循环防护

- **现象**：后台任务（如长测试）运行时，连续 3 次调用 `job_output` 同一 jobId，第 3 次返回 `"重复循环防护已触发"` 错误，工具拒绝执行。
- **原因**：`job_output` 内置了相同参数连续调用检测——3 次相同参数即触发拦截，防止 AI 陷入 `job_output` → 仍在运行 → 立即重试的死循环。
- **解决**：
  1. 任务提交后用 `list_jobs`（不同参数、不触发防护）查看所有任务状态，而非反复 `job_output` 同一 id
  2. 或间隔等待后再调用 `job_output`（让中间有其他工具调用打断连续序列）
  3. 对快速任务，直接用 `bash` 同步执行测试/编译，避免后台化


## 5. 怀疑工具行为异常时，用最小对照实验定位根因

- **现象**：`grep("弹窗|弹框|dialog|...")` 返回空。不是立即切 bash grep，而是先做对照实验：`grep("弹窗")` → 2 matches，`grep("弹窗|弹框")` → 0 matches。两步定位根因：内置 grep 使用 BRE 基本正则，`|` 被当作字面量管道符而非 OR 运算符。
- **原因**：对照实验以最小代价（两个单关键词 grep）精确隔离了变量，2 次调用就定位到根因是正则方言问题，而非 include 过滤、缓存、路径等其他可能。如果直接切 bash grep，根因会被掩盖。
- **解决**：工具返回意外空结果时，先用一个**极简对照实验**（如去掉特殊字符、缩短 pattern）排除干扰变量，再决定是回退 bash 还是修复调用方式。这比#2 的"一次失败就切"更精细——对照实验本身就是"切"的一种形式。

## 6. 删除功能时影响面分析要覆盖间接引用 + 多入口

- **现象**：删除 `spawn_explorer` 后 `tsc --noEmit` 报错——`skill-load-handler.ts` 仍在 `import { EXPLORER_SYSTEM } from "./code-executor"`。初次影响面分析只 grep 了 `spawn_explorer`，遗漏了关联常量名 `EXPLORER_SYSTEM`。此外，`spawn_explorer`（直接工具）和 `explore` skill（SkillLoad 入口）是同一设计的两个入口，第一次只删了工具，skill 回退逻辑仍保留，导致需要二次修改。
- **原因**：
  1. 影响面分析只搜索了功能名，未搜索关联常量/类型名
  2. 同一设计可能有多个入口（直接工具 + SkillLoad + 内置 skill 回退），未做全入口识别
- **解决**：
  1. 删除前 grep 功能名**和**关联常量名（如 `EXPLORER_SYSTEM`、`EXPLORER_GUIDANCE`）两者
  2. 删除前问自己：这个功能有几个入口？有没有内置回退？有没有测试断言它存在？
  3. 删除后立即跑 `tsc --noEmit` + 相关测试，以编译器为第一道防线
- **验证**（本轮）：第二轮清除 explore skill 时，删除后 `tsc --noEmit` 零错误，全项目 `grep explorer` 零匹配。

## 7. `run_background` 前先确认目标文件/命令存在

- **现象**：`run_background` 传了不存在的测试文件路径 `executor.test.ts`，后台任务直接挂起。之后连续 3 次 `job_output` 返回 `(no output yet)`，用户打断问"为什么执行了 14 分钟"才发现问题。
- **原因**：没有先验证测试文件是否存在就直接提交后台任务；`(no output yet)` 的持续返回未触发任何警觉。
- **解决**：
  1. 提交后台任务前，先用 `glob` 或 `ls` 确认目标文件/命令存在
  2. 提交后用 `list_jobs` 查看状态（不同参数、不触发 #4 的循环防护）
  3. 如果 30 秒内 `job_output` 无任何输出，应怀疑任务异常

## 8. 代码修改后立即跑对应测试，不等"全部改完再测"

- **现象**：修改 prompt.ts 删除了 `spawn_explorer` 相关内容，但未同步修改 `prompt.test.ts`。测试在 3 轮对话后才跑，发现 2 个失败——测试断言了已删除的功能。修复测试需要额外一次编辑往返。
- **原因**：修改和测试之间隔了多轮对话，上下文丢失导致忘记测试中也引用了已删除的功能。
- **解决**：每完成一个文件的修改，立即跑该文件对应的测试（`src/tests/<模块名>.test.ts`）。删除型修改尤其如此——测试中的断言是对功能存在性的"第二份引用清单"，能在编译通过后捕获遗漏。

## 9. 回答代码理解问题时过度探索 —— The Stopping Problem（2025-05-20 暴露）

- **现象**：用户问"本项目中的智能体循环是什么样的？"，读取了 session.ts、prompt.ts、executor.ts、storm.ts、scavenge.ts、code-executor.ts、model-capabilities.ts、App.tsx 共 8+ 个文件后才回答，还"顺便"做了 pi 对比分析、查会话存储、解析损坏 JSON、查定价模型。实际 session.ts 的 3 个段落就足够覆盖核心答案。累计 456k tokens，耗时 3m51s，费用 ¥0.145。作为对照，同一问题用另一个会话回答仅用 3 个文件、262k tokens、¥0.12、不到 1 分钟。

- **原因**：
  1. 系统提示词中"探索子系统"、"先 read_file 获取足够上下文"等指令缺乏对等的"够了就停"反制力，形成了"多探索单向通道"
  2. handle_read 缓存切片无边际成本感知，每次调用看起来都"免费"，导致"再读一段也无妨"的累积效应
  3. 目标蔓延（Goal Creep）：从"回答智能体循环"滑向"顺便对比 pi 的性能" → "顺便查定价模型" → "顺便查会话存储"，每一步都是上一步的"自然延伸"，但没有人在中间打断
  4. 缺少完成度自评机制（Stopping Check）：读完 3 个文件后没有自问"够回答了吗？"

- **解决**：
  1. 回答理解型问题前，用 todo_write 规划最多要读几个文件（≤4 个）
  2. 每读完一个文件，自问"当前信息足够回答用户问题了吗？"
  3. 够了 → 停止探索，组织答案；不够 → 只加 1 个补充文件，然后必须回答
  4. 发现自己正在做"顺便"任务 → 立刻停止，回到用户问题原意
  5. 代码修改任务遵循 CODE_EXECUTOR_GUIDANCE；理解问题遵循 SYSTEM_PROMPT_BASE 中的探索策略，两者不混淆
## 10. CRLF 文件导致 `edit` 失败 — 用 Python 脚本或 `snippet_id` 绕过

- **现象**：`edit` 反复返回 `"old_string not found"`，但肉眼确认字符串确实存在。改用 `bash grep` 也能找到目标文本。最终用 `python3 /tmp/script.py` 成功替换。
- **原因**：
  1. 项目文件使用 CRLF 行尾（`
`），而 `edit` 的 `old_string` 使用 LF（`
`），精确字符串匹配因行尾差异失败
  2. 文件被部分读取后，`edit` 在 snippet 范围内搜索，但 snippet 引用的是旧缓存，修改后缓存失效
- **解决**：
  1. 简单替换：先用 `read` 以 `snippet_id` 读取目标区域（自动处理行尾），再 `edit` 以该 snippet 为范围
  2. 复杂替换（多行/大块）：直接写 Python 脚本到 `/tmp/*.py`，用 `bash python3` 执行
  3. 跨文件重构：一个 Python 脚本完成所有替换，减少工具调用次数
- **排查信号**：`file` 命令输出 `with CRLF line terminators`；`edit` 返回 `closest_match` 相似度 ≥0.98

## 11. `edit` 失败后不要 `read` 全文件 — 用 `offset/limit` 精准重读

- **现象**：`edit` 失败后，立即调用 `read` 不带 offset/limit 读取整个大文件（如 1000+ 行），只为刷新缓存。一个 1000 行文件占 ~30k tokens。
- **原因**：直觉认为"需要看到全部内容才能确认问题"，但实际上只需要确认目标字符串存在并获取其上下文。
- **解决**：
  1. `edit` 失败后，先用 `bash grep -n "目标字符串" file.ts` 精确定位行号
  2. 再用 `read(file_path, offset=LINE-5, limit=15)` 只读取目标行及其上下文（~20 行）
  3. 如果目标是修正 CRLF 问题，改用 #10 的 Python 脚本方案

## 12. Python `/tmp/` 脚本是可靠的复杂替换方案 — 但注意清理

- **现象**：当 `edit`/`multi_edit` 无法处理 CRLF 文件或多行匹配时，写 Python 脚本到 `/tmp/fix_xxx.py` 并通过 `bash python3 /tmp/fix_xxx.py` 执行。本轮 4 个不同脚本均一次成功。
- **原因**：Python 的字符串操作不受 CRLF 影响，可以精确控制读取、替换、写回。临时文件 `/tmp/` 在不同 bash 调用之间持久存在。
- **解决**：
  1. 对复杂替换（含中文、模板字符串、多行嵌套），第一时间考虑 Python 脚本，而非反复尝试 `edit`
  2. 脚本结构：`read file → str.replace(old, new) → write file`
  3. 替换后**必须**删除临时文件：`rm -f /tmp/fix_*.py`，否则累积
  4. 脚本内容先用 `write` 工具写入 `/tmp/`，再用 `bash python3` 执行

## 13. 需求清单创建后就锁定范围 — 防止目标蔓延（Scope Creep）

- **现象**：创建了包含 32 个子项的完整需求清单后，跨多轮逐项实施。但在第 3 轮后仍有 3 项未做。每轮"开始实施"前没有锁定本轮范围，导致分散实施。
- **原因**：
  1. 需求清单作为总 TODO 存在，但没有"本轮实施范围"的子清单
  2. 每轮"开始实施"前，AI 自己决定优先级，而非与用户确认本轮范围
  3. 跨轮次之间上下文窗口限制导致前期做的某些需求被遗忘
- **解决**：
  1. 用户说"开始实施"时，先用 `todo_write` 列出**本轮**要做的子项清单，请用户确认后再动手
  2. 一轮只做一个模块（如"本轮只做 PromptInput 拆分"），完成后再问"下轮做什么"
  3. 每轮结束时用 `todo_write` 清空，下轮开始时重建

## 14. P0 优先级需重新评估 — 非所有 P0 都值得做

- **现象**：需求 1.1（状态管理重构，P0）被列为最高优先级，但在实际评估中发现：将 18 个简单 `useState` 聚合为 `useReducer` 的边际收益极低（这些状态独立更新、频率不高），而风险极高（需重写 App.tsx 中几乎所有函数）。最终 1.1 成为唯一未完成项。
- **原因**：
  1. 需求清单创建时对代码了解不深，凭直觉分配了优先级
  2. "P0" 标签一旦贴上就产生了心理锚定，后续没有重新评估
  3. 将"重构"和"新功能"混在同一个优先级体系里——重构的风险天然高于同优先级的新功能
- **解决**：
  1. 实施前对每个 P0 做 **5 分钟影响面评估**：改动涉及多少函数？多少测试？回滚成本？
  2. 如果改动风险 > 预期收益，主动向用户说明并建议降级
  3. P0 重构类需求优先做模块拆分（提取独立文件/函数），而非改动内部实现（如 state → reducer）
