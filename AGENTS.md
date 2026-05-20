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

## 禁止
- 写 JS/TS 源码时使用中文引号 `""` → 用《》
- 索引过期时反复 `gitnexus_query`
- 修改代码后不跑相关测试

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

## 3. `search_files` 不如 `glob` 可靠，优先用 `glob`

- **现象**：`search_files "models.generated.ts"` 返回空（找不到），但 `glob "**/*models*generated*"` 立即找到。
- **原因**：`search_files` 对根目录级文件或特定路径模式匹配不如 `glob` 稳定。
- **解决**：按文件名模式搜索文件位置时，优先用 `glob`。`search_files` 仅在有明确文件名片段需要语义模糊匹配时使用。

## 4. 已知行号时，多个 `handle_read` 可并行

- **现象**：查价格时，先用 `bash grep -n` 获得了所有 deepseek 模型的行号，之后串行调用了 9 次 `handle_read` 逐段读取。
- **原因**：习惯性串行，未意识到 `handle_read` 之间无依赖关系（读取的是同一文件的不同区域）。
- **解决**：如果已通过 `grep -n` 或类似方式知道所有目标行号范围，多段 `handle_read` 并行调用，减少 RTT 延迟。一次性发出所有读取请求，再统一汇总。
