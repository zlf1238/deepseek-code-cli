<!-- gitnexus:start -->
# GitNexus

修改符号前 `gitnexus_impact`，提交前 `gitnexus_detect_changes()`。探索代码优先 `gitnexus_query` 而非 grep。索引过期：`npx gitnexus analyze`。
<!-- gitnexus:end -->

---

# 规则

## 工具策略
- `grep` 返回空 → 立刻 `bash grep`；`directory_tree` 返回空 → 立刻 `bash ls/find`
- 大文件(>500行)：先 `get_file_info` 再精准 `offset/limit`
- 同一文件多处修改：`multi_edit` 一次提交
- 探索子系统：`spawn_explorer`，不要手动 grep+read 5+ 文件

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

## 5. Explorer 超时时应缩小任务范围重试，而非放弃

- **现象**：`spawn_explorer` 任务"审查 prompt.ts 中所有工具描述"超时（20 次迭代耗尽），prompt.ts 有 1234 行，工具定义分散其中，Explorer 逐个读取分析导致迭代爆表。
- **原因**：任务描述范围过大。Explorer 会忠实地逐一审查每个工具，当文件大、工具多时迭代不够用。
- **解决**：对超大范围任务，拆分为更小的子任务：第一步让 Explorer 提取所有工具名称和行号范围，第二步针对性审查可疑项。或者直接手动执行——用 `bash grep` 快速扫描关键描述词，再定向读取。

## 6. 怀疑工具行为异常时，用最小对照实验定位根因

- **现象**：`grep("弹窗|弹框|dialog|...")` 返回空。不是立即切 bash grep，而是先做对照实验：`grep("弹窗")` → 2 matches，`grep("弹窗|弹框")` → 0 matches。两步定位根因：内置 grep 使用 BRE 基本正则，`|` 被当作字面量管道符而非 OR 运算符。
- **原因**：对照实验以最小代价（两个单关键词 grep）精确隔离了变量，2 次调用就定位到根因是正则方言问题，而非 include 过滤、缓存、路径等其他可能。如果直接切 bash grep，根因会被掩盖。
- **解决**：工具返回意外空结果时，先用一个**极简对照实验**（如去掉特殊字符、缩短 pattern）排除干扰变量，再决定是回退 bash 还是修复调用方式。这比#2 的"一次失败就切"更精细——对照实验本身就是"切"的一种形式。
