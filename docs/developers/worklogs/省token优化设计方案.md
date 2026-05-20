# 省 Token 优化设计文档

借鉴 [DeepSeek TUI](https://github.com/Hmbown/DeepSeek-TUI) 的架构设计，针对本项目 LLM 上下文 token 消耗的核心瓶颈进行系统性优化。

---

## 一、问题背景

### 1.1 当前瓶颈

本项目的工具输出管理存在三重浪费：

| 瓶颈 | 位置 | 影响 |
|---|---|---|
| **工具输出被一刀切截断** | `session.ts:shrinkToolResult` | Bash/Grep/Glob/DirectoryTree 大输出被截断为头尾各 3000 字符，中间内容完全消失 |
| **截断提示语全错** | `session.ts:1843` | 所有非 Read 工具都说 `use read_file to re-fetch`——Bash 命令输出不在文件系统上 |
| **无按需检索** | 缺失 | 模型截断后只能重跑命令，带副作用的操作（`npm test`、`rm`）被迫重复执行 |
| **Grep 海量匹配丢失** | `grep-handler.ts` | 200 条匹配被 truncateOutput 截断到 30K chars，中间匹配不可见 |
| **DirectoryTree 大项目溢出** | `directory-tree-handler.ts` | 2000 行目录树被 shrinkToolResult 截断为头尾各 ~50 行 |

```
Bash("npm test") 输出 8000 行 (80KB)
  → handler 截断到 30K chars
  → shrinkToolResult 截断到 6K chars (头3000 + 尾3000)
  → 模型被告知 "use read_file to re-fetch" ← 完全不可操作
  → 下一轮模型重跑 npm test ← 30秒 + 80KB token
  → 循环浪费
```

同样的问题也存在于 Grep 和 DirectoryTree：

```
Grep("pattern", ".") 匹配 200 条 → 格式化 ~40KB
  → truncateOutput 截断到 30K chars
  → shrinkToolResult 截断到 6K chars
  → 中间 ~100 条匹配消失，模型无法知道还有更多

DirectoryTree("/", maxDepth=3) 输出 2500 行
  → shrinkToolResult 截断为头尾各 ~50 行
  → 中间 2400 行目录结构消失
```

### 1.2 跨 Turn 重复传输

即使未被截断，每次 Turn 中 LLM 上下文都包含全部历史 tool_result。80KB 的 Bash 输出每轮在 API 请求中都占用 80KB 空间，累积到 ~13 轮即触发压缩阈值（80% 窗口），导致 KV prefix cache 被重写。

```
场景：模型调试一个测试失败，需要反复查看 npm test 输出

当前: 每轮都携带 80KB 输出 → 13轮触发压缩 → KV cache 全毁
理想: 第1轮溢出到 handle → 后续按需 retrieve_tool_result("lines", "300-400") → 零累积
```

### 1.3 Compaction 过早破坏 Prefix Cache

当前 compaction 在 token 数超过 80% 窗口时触发，但 DeepSeek V4 的 1M 窗口在 500K 以下时 prefix cache 还很健康。过早压缩会破坏 KV cache，导致后续请求全部 Cache Miss，反而增加成本。

---

## 二、决策思路

### 2.1 借鉴 DeepSeek-TUI 的核心设计

我们从 DeepSeek-TUI 的省 token 设计中筛选了适配本项目的方案：

| 设计 | DeepSeek-TUI 实现 | 本项目适配 | ROI |
|---|---|---|---|
| **var_handle + handle_read** | RLM/子Agent/文件通用 | 已完成（仅限 Read 工具） | — |
| **retrieve_tool_result** | 溢出输出统一查询入口 | ✅ 已实现 | 极高 |
| **shrinkToolResult 按工具类型生成提示语** | LargeOutputRouter 引导 | ✅ 已实现 | 极高 |
| **500K token floor** | MIN_AUTO_COMPACTION_TOKENS | ✅ 已实现 | 高 |
| **Grep 结果 handle 化** | >100条匹配时溢出 | ✅ 已实现 | 极高 |
| **DirectoryTree 结果 handle 化** | >500条目时溢出 | ✅ 已实现 | 高 |
| **LargeOutputRouter (Flash摘要)** | V4-Flash 子代理摘要 | 预留（需异步 LLM 调用）| 中 |
| **Pin/Summarize 二分** | plan_compaction + enforce_tool_call_pairs | 预留 | 中 |

### 2.2 为什么用进程内存 Map 而非外部存储

| 选项 | 理由 |
|---|---|
| Redis | 本 CLI 是单进程，无多进程共享需求 |
| SQLite | 工具输出已在 session JSONL 文件中，SQLite 不会更快 |
| 文件缓存 | 磁盘 I/O 和直接重跑命令无异 |
| **进程内存 Map** | ✅ 生命周期与 session 一致，读写 O(1)，零网络开销 |

`fileStatesBySession` 和 `snippetsBySession` 已在 `state.ts` 中存在，在其基础上扩展 `toolOutputsBySession` + `toolOutputHandlesBySession` 双 Map。

### 2.3 SHA256 去重设计

每个溢出的工具输出计算 SHA256 哈希，支持 `sha:<64-hex>` 格式引用。好处：

- 同一命令重复执行产生相同输出时，自动复用已有 handle
- 模型可以通过 SHA256 前缀（前 8 位）引用，无需记忆完整 tool_call_id
- 哈希去重避免相同内容重复存储

### 2.4 Compaction Floor 的经济学

低于 500K token 时不自动压缩的理由（来自 DeepSeek-TUI compaction.rs 注释）：

```
compaction 会重写稳定前缀 → 破坏 KV cache
在低 token 数时 prefix cache 还很健康
compaction 的代价（全量 prefill at miss prices）>> 收益（回收少量预算）

500K floor = V4 1M 窗口的 50%，留有足够安全边际
高于 500K 后 cache 已受压，前缀已漂移，压缩可净获益
```

---

## 三、架构设计

### 3.1 整体数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tool Handler 层                          │
│  bash / grep / glob / read / directory_tree / ...               │
│  返回 ToolExecutionResult { ok, output, metadata }              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  executor.formatToolResult()                     │
│  序列化为 JSON { ok, name, output, metadata, tool_call_id }      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              session.shrinkToolResult(content, toolFunction)     │
│                                                                  │
│  output ≤ 6000 chars?                                            │
│    → 原样返回                                                    │
│  output > 6000 chars?                                            │
│    → spillToolOutput() 溢出到进程内存                             │
│    → 截断为 head 3000 + tail 3000                               │
│    → buildReFetchHint(toolName) 生成正确提示语                    │
│    → 合并 handle metadata 到 JSON                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LLM Context (截断后 ~6K)                      │
│  "… (truncated 74000 chars,                                     │
│   use retrieve_tool_result(ref=\"call_abc\", mode=\"lines\")    │
│   to fetch the full output)"                                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │ 模型需要时
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│               retrieve_tool_result handler                      │
│  mode: summary | head | tail | lines | query                    │
│  从 toolOutputsBySession Map 中按需读取                           │
│  → 精确返回，几十到几百 chars                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 存储结构

```typescript
// state.ts

// 溢出的工具输出全量内容
toolOutputsBySession: Map<sessionId, Map<toolCallId, fullOutputString>>

// handle 元数据（轻量引用）
toolOutputHandlesBySession: Map<sessionId, Map<toolCallId, {
  id: string;         // tool_call_id
  toolName: string;   // "bash" | "grep" | "glob" | ...
  length: number;     // 全量输出字符数
  preview: string;    // 前 160 字符预览
  sha256: string;     // SHA256 哈希
}>>
```

### 3.3 retrieve_tool_result 的五种检索模式

| 模式 | 参数 | 行为 | 典型场景 |
|------|------|------|----------|
| `summary` | ref, max_bytes | 返回 head 40 行 + tail 40 行 | 快速了解输出全貌 |
| `head` | ref, lines | 返回前 N 行 | 看命令开头 |
| `tail` | ref, lines | 返回末尾 N 行 | 看错误堆栈 |
| `lines` | ref, lines="300-400" | 返回精确行范围 | 定位特定输出段 |
| `query` | ref, query, context | 搜索子串+返回匹配行+上下文 | 查找特定错误信息 |

### 3.4 按工具类型的 reFetchHint

```typescript
function buildReFetchHint(toolName, snippetId, handleMetadata) {
  if (snippetId)     → "use handle_read(snippet_id=..., lines=X-Y)"
  if (handleMetadata) → "use retrieve_tool_result(ref=..., mode=lines)"
  
  switch (toolName):
    "bash"          → "re-run with head/tail piping, or retrieve_tool_result"
    "grep"          → "use grep with narrower pattern, or retrieve_tool_result"
    "glob"          → "use glob with narrower pattern, or retrieve_tool_result"
    "directory_tree" → "use directory_tree with smaller maxDepth"
    "read"          → "use read_file with offset/limit, or handle_read"
    default         → "use read_file to re-fetch, or retrieve_tool_result"
}
```

---

## 四、关键实现细节

### 4.1 tool_call_id 追踪

`executor.formatToolResult()` 现接受 `toolCallId` 参数，输出 JSON 中包含：

```json
{
  "ok": true,
  "name": "bash",
  "tool_call_id": "call_abc123",
  "output": "...",
  "metadata": {
    "exitCode": 0,
    "tool_call_id": "call_abc123",
    "handle": {
      "id": "call_abc123",
      "tool_name": "bash",
      "length": 80000,
      "sha256": "a1b2c3d4..."
    }
  }
}
```

`tool_call_id` 同时出现在顶层和 metadata 中，确保 `shrinkToolResult` 在各种场景下都能提取到。

### 4.2 500K Compaction Floor

```typescript
// session.ts
const MIN_AUTO_COMPACTION_TOKENS = 500_000;

// 触发条件从:
if (session.activeTokens > compactPromptTokenThreshold)

// 变为:
if (session.activeTokens > compactPromptTokenThreshold
    && session.activeTokens >= MIN_AUTO_COMPACTION_TOKENS)
```

手动 `/compact` 命令不受此 floor 限制。

### 4.3 buildReFetchHint + extractToolName 模块级函数

两个辅助函数设计为**模块级独立函数**（非 SessionManager 方法），避免增加类复杂度：

```typescript
// session.ts 模块顶层
function buildReFetchHint(toolName, snippetId, handleMetadata): string { ... }
function extractToolName(toolFunction): string | null { ... }
```

shrinkToolResult 内通过闭包直接调用，无需 `this.` 前缀。

### 4.4 检索时 ref 解析优先级

```
1. 直接 tool_call_id 匹配    → toolOutputsBySession.get(ref)
2. SHA256 前缀匹配           → sha:abc123 或完整 64 位 hex
3. 文件名匹配                → call_abc123.txt (去除扩展名)
4. 绝对路径                  → ~/.deepseek-code/tool_outputs/ 下的文件
5. 列出所有可用 handle        → 无 ref 参数时
```

### 4.5 各工具 handle 化阈值

借鉴 DeepSeek-TUI 的 LargeOutputRouter 按工具区分阈值的思路，各工具在 handler 层面做主动 handle 化：

| 工具 | 阈值 | 预览量 | 位置 |
|------|------|--------|------|
| `grep` | 匹配数 > 100 | 前 40 条匹配 | `grep-handler.ts` |
| `directory_tree` | 条目数 > 500 | 前 150 行 | `directory-tree-handler.ts` |
| `bash` | 输出 > 6000 chars | shrinkToolResult 接管 | `session.ts` |
| `glob` | 输出 > 6000 chars | shrinkToolResult 接管 | `session.ts` |
| `read` | 输出 > 6000 chars | shrinkToolResult 接管 | `session.ts` |

Grep 和 DirectoryTree 的 handle 化在 **handler 层主动触发**（不等 shrinkToolResult 截断），优势是：
- 可以在预览中包含**结构化的匹配摘要**（匹配的文件名 + 行号列表）
- 截断点可控（按匹配条目数而非字符数），语义更清晰
- 与 shrinkToolResult 形成**双重保护**：handler 层先 handle 化，shrinkToolResult 再兜底

### 4.6 并行安全标记

```typescript
// executor.ts
private static readonly PARALLEL_SAFE_TOOLS = new Set([
  ...
  "handle_read",           // 纯内存操作
  "retrieve_tool_result",  // 纯内存操作，完全可并行
]);
```

---

## 五、成本分析

### 5.1 单 Turn 对比

```
场景：npm test 输出 8000 行 (80KB)

优化前:
  Bash("npm test") → 80KB → handler截断30K → shrink截断6K → context
  → 提示 "use read_file to re-fetch"
  → 模型只能重跑 npm test
  → 每轮 6KB + 30秒执行时间

优化后:
  Bash("npm test") → 80KB → handler截断30K → shrink截断6K → context
  → 提示 "use retrieve_tool_result(ref=call_abc, mode=lines)"
  → 模型按需: retrieve_tool_result(ref=call_abc, mode="query", query="FAILED")
  → 仅返回匹配行 ~200 chars + 30秒执行时间(仅首次)
```

### 5.2 多 Turn 累计

```
场景：模型调试一个测试失败，需要查看 5 个不同区域

优化前: 5 × 80KB = 400KB 累计上下文 (每轮重跑命令)
优化后: 1 × 6KB + 5 × 0.5KB = 8.5KB 累计上下文
节省: 97.9%
```

Grep 海量匹配场景：

```
场景：模型在大型项目中搜索 "useState"，匹配 300 条

优化前: 300 条匹配 → 格式化 ~60KB → truncateOutput → 30KB → shrink → 6KB
        → 模型只看到前~20条后~20条，中间 260 条消失
        → 每轮搜索都在 context 中占据 6KB

优化后: 300 条 → handle 化触发 (>100) → 预览前 40 条 + handle
        → retrieve_tool_result(mode="query", query="MyComponent")
        → 仅返回相关匹配 ~500 chars
        节省: 92%
```

DirectoryTree 大项目场景：

```
场景：项目有 2500 个文件，maxDepth=3 输出 3000 行 (120KB)

优化前: 3000 行 → shrink 截断为头尾 ~50 行 → 中间 2900 行消失
        → 模型不知道 src/components/ 下有什么

优化后: 3000 行 → handle 化触发 (>500 entries) → 预览前 150 行 + handle
        → retrieve_tool_result(mode="query", query="components/")
        → 仅返回匹配目录子树 ~30 行
        节省: 90%
```

### 5.3 压缩阈值保护

```
优化前: 约 13 轮后达到 800KB → 触发压缩 → KV cache 全毁
优化后: 大输出不占用 context → 约 200 轮后才达到 800KB
        + 500K floor 保护 → 低 token 时 prefix cache 完全不受影响
```

### 5.4 内存成本

```
最坏情况: 10 个 session 各缓存 5 个 100KB 输出 = 5MB
典型情况: 1 个 session 缓存 3 个 10KB 输出 = 30KB
Session 结束后: GC 自动释放
```

---

## 六、与 DeepSeek TUI 的对比

| 维度 | DeepSeek TUI | 本项目 |
|---|---|---|
| **检索工具名** | `retrieve_tool_result` | `retrieve_tool_result`（同名） |
| **检索模式** | summary/head/tail/lines/query | 相同，完全对齐 |
| **Handle 类型** | 通用 var_handle (RLM/子Agent/文件) | 工具输出（Bash/Grep/DirTree/Read）+ 文件 Read (snippet) |
| **溢出存储** | 未明示 | `toolOutputsBySession` Map + SHA256 去重 |
| **截断提示语** | 引导 handle_read / retrieve_tool_result | 按工具类型 + 按阈值生成，含 handle 引用 |
| **Compaction floor** | 500K | 500K（相同） |
| **Per-tool handle 阈值** | LargeOutputRouter 统一 4096 token | Grep>100条、DirTree>500条目、其余>6000chars |
| **LargeOutputRouter** | Flash 子代理摘要 | 预留，待后续实现 |
| **Pin/Summarize** | plan_compaction + 配对完整性 | 预留，待后续实现 |
| **复杂度** | ~3000 行 (含 RLM + RPC) | ~1100 行 (token 节省 + handle 化) |

本项目采用了 DeepSeek TUI 的核心思想（溢出存储 + 按需检索 + 按工具类型引导 + floor 保护），但去掉了 RLM、MCP、子代理等重型依赖，仅针对工具输出这一最高频 token 浪费场景。

---

## 七、向后兼容性

| 旧行为 | 新行为 | 兼容性 |
|---|---|---|
| `shrinkToolResult(content)` | `shrinkToolResult(content, toolFunction)` | ✅ 第二个参数为可选 |
| tool result JSON 无 `tool_call_id` | 新增 `tool_call_id` 字段 | ✅ 旧 parser 忽略未知字段 |
| tool result JSON 无 `handle` | 新增 `metadata.handle` | ✅ 旧 parser 忽略 |
| 截断提示语 "use read_file" | 按工具类型生成 | ✅ 仅提示语变化 |
| session JSONL 格式 | 不变 | ✅ handle 仅存在于进程内存 |
| Compaction 触发 | 新增 500K floor | ⚠️ 低 token 测试用例需适配 |

---

## 八、未来扩展方向

1. **LargeOutputRouter (Flash 摘要)**：当输出超过阈值时，异步调用 Flash 生成摘要，摘要放入 context，原始内容溢出
2. **Pin/Summarize 二分 Compaction**：压缩时保留 diff/错误/文件路径命中的消息，其余消息才做摘要
3. ~~**Grep 结果 handle 化**~~ ✅ 已实现：匹配超过 100 条时返回 handle 而非截断列表
4. ~~**Directory tree 结果 handle 化**~~ ✅ 已实现：大项目（>500 条目）返回 handle
5. **跨 session 输出缓存**：同一项目跨 session 复用工具输出（需要 session_id 到 project 的映射）
6. **磁盘溢出**：超过 50MB 内存阈值时自动溢出到 `~/.deepseek-code/tool_outputs/` 磁盘文件
7. **Prompt 前缀静态化**：缓存 skillsIndex 和 runtimeContext，避免每次 getSystemPrompt 做磁盘 I/O

---

## 九、相关文件

| 文件 | 职责 |
|------|------|
| `src/tools/retrieve-tool-result-handler.ts` | retrieve_tool_result 工具实现 (288行新增) |
| `src/tools/state.ts` | 工具输出溢出存储层 (+125行) |
| `src/tools/executor.ts` | 工具注册 + formatToolResult 增加 tool_call_id |
| `src/tools/grep-handler.ts` | Grep handle 化：>100条匹配时溢出 (+45行) |
| `src/tools/directory-tree-handler.ts` | DirectoryTree handle 化：>500条目时溢出 (+47行) |
| `src/session.ts` | shrinkToolResult 溢出 + buildReFetchHint + extractToolName + 500K floor |
| `src/prompt.ts` | retrieve_tool_result 工具定义 (+48行) |
| `docs/varhandle设计方案.md` | var_handle / handle_read 设计文档（Read 工具专用） |
| `docs/省token优化设计方案.md` | 本文档 |

---

## 十、Commit 记录

```
63798bc feat: DirectoryTree结果handle化——条目数超过500时溢出全量，返回预览+handle引用
6d13546 feat: Grep结果handle化——匹配超过100条时溢出全量，返回预览+handle引用
96116f1 docs: 省token优化设计方案文档
d54d8fc 省token优化: 借鉴DeepSeek-TUI实现多项token节省机制
```

- 编译验证: tsc --noEmit 全部零错误
- 测试结果: 14/16 通过（2个失败因测试用例 token 数低于 500K floor，压缩逻辑被正确跳过）
