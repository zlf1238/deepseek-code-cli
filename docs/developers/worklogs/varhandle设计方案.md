# var_handle 设计文档

## 一、问题背景

### 1.1 当前瓶颈

本项目的 `Read` 工具在处理大文件时面临双重瓶颈：

| 瓶颈 | 位置 | 影响 |
|---|---|---|
| **默认 2000 行限制** | `read-handler.ts:12` | 超过 2000 行的文件只能看到前 2000 行 |
| **6000 字符截断** | `session.ts:1700` | 2000 行输出约 120KB → 截断为首尾各 3000 字符 ~ 首尾各 50 行 |

模型调用 `Read("big.ts")` 返回 2000 行，中间 1900 行被 `shrinkToolResult` 丢弃。下次 Turn 需要看第 1500-1600 行时，即使调用 `Read("big.ts", offset=1500, limit=100)`，结果依然被截断为约 100 行的首尾。

**根本问题**：工具结果作为整体被截断，模型无法精确获取特定行范围而不产生大量冗余传输。

### 1.2 跨 Turn 重复传输

即使未被截断，每次 Turn 中模型的上下文都包含全部历史消息——包括之前所有 Read 的完整结果。60KB 的文件内容每轮在 LLM API 请求中都占 60KB 空间，累积到 ~13 轮即触发压缩阈值（80% 窗口），导致 KV prefix cache 被重写，所有后续 Cache Miss。

---

## 二、决策思路

### 2.1 为什么选择 var_handle 而非其他方案

我们考察了三个方案：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 调大截断上限 | 将 6000 改为更大值 | 零改动 | 治标不治本，大文件仍占窗口 |
| B. 智能分块返回 | Read 返回元数据 + 让模型选择范围 | 较简单 | 跨 Turn 仍需重新 Read |
| C. var_handle | 全量缓存 + 句柄引用 + 按需切片 | 根本解决 | 需要新增工具 + 缓存管理 |

**选 C 的理由**：

1. 方案 A 推迟了压缩但不解决窗口占用问题
2. 方案 B 解决了单 Turn 的传输效率，但不解决跨 Turn 重复传输
3. 方案 C 从根本上改变了模型读取文件的模式：一次全量加载，后续零成本切片

### 2.2 为什么不用外部存储

| 选项 | 理由 |
|---|---|
| Redis | 本 CLI 是单进程，无多进程共享需求 |
| SQLite | 文件内容已存在文件系统，SQLite 不会更快 |
| 文件缓存 | 磁盘 I/O 和直接读文件无异 |
| **进程内存 Map** | ✅ 生命周期与 session 一致，读写 O(1)，零网络开销 |

`fileStatesBySession`（`Map<string, Map<string, FileState>>`）和 `snippetsBySession`（`Map<string, Map<string, FileSnippet>>`）已在 `state.ts` 中存在，只需在其基础上扩展功能。

### 2.3 缓存失效策略

选择 **mtime 脏检测**而非 TTL 或版本号：

```
Read("f.ts", t=1000) → 缓存内容 + timestamp=1000
edit("f.ts")         → 磁盘 mtime 变为 1001
handle_read("s_1")   → fs.statSync.mtimeMs=1001 > fileState.timestamp=1000 → stale → 回源
```

- TTL 的问题：不知道文件何时被编辑，设短了浪费缓存，设长了看不到最新内容
- 版本号的问题：外部进程（git checkout）修改文件不会更新内部版本号
- mtime：文件系统原生保证，零维护成本

### 2.4 全量加载 vs 按需加载

```
Read("big.ts", offset=5000, limit=200)
  → 只缓存 5000-5199  ← 模型明确指定了范围，尊重其意图

Read("big.ts")  // 无参数
  → 全量加载到缓存（≤10MB）  ← 模型想看文件全貌，全量缓存方便后续探索
  → 只返回前 2000 行给模型
```

逻辑：无参数 Read 表示"我想探索这个文件"，全量缓存让后续 `handle_read` 全部命中。带参数的 Read 表示"我只关心这个范围"，精确缓存避免浪费。

---

## 三、架构设计

### 3.1 三层回退

```
┌──────────────────────────────────────────────────┐
│ Level 1: 进程内存 (Map)                            │
│   fileStatesBySession.get(sid).get(path)          │
│   存储: 全量文件内容字符串                          │
│   生命周期: session 期间                           │
│   命中条件: snippet_id 存在 + 文件未过时            │
├──────────────────────────────────────────────────┤
│ Level 2: 磁盘 JSONL (snippet 元数据)               │
│   ~/.deepseek-code/projects/<p>/sessions/<s>.jsonl│
│   存储: snippet_id + filePath + startLine/endLine │
│   生命周期: 永久                                   │
│   命中条件: resume 时 restoreSnippetsFromHistory   │
│   命中后: 自动回退到 Level 3                       │
├──────────────────────────────────────────────────┤
│ Level 3: 文件系统 (真实文件)                        │
│   /root/src/big.ts                                │
│   handle_read 的最终回源                            │
│   在任何缓存层失败时自动触发                         │
└──────────────────────────────────────────────────┘
```

### 3.2 数据流

```
Turn 1:
  Model: Read("big.ts")
  → readTextFile() 读取前 2000 行
  → 判断 isImplicitFullRead && isPartialView → 后台全量加载
  → markFileRead(content=全量10000行)
  → createSnippet(startLine=1, endLine=10000)
  → 返回 { output: "1\t...\n2000\t...", metadata: { snippet: {id:"s_1",...}, total_lines: 10000, hint: "..." } }
  → shrinkToolResult: output > 6000 → 截断, hint 含 handle_read(snippet_id="s_1",...)

Turn 2:
  Model: handle_read("s_1", lines="5000-5200")
  → getSnippet("s_1") → FileSnippet{ filePath: "big.ts", startLine:1, endLine:10000 }
  → isFileStale: stat.mtimeMs <= fileState.timestamp → 不过时
  → readSnippetLines: 从 fileState.content 切片 lines[4999:5200]
  → 返回 200 行 cat -n 格式 → ~6KB, 不触发截断

Turn 2 (编辑后):
  Model: edit("big.ts", ...)
  → 磁盘 mtime 更新

Turn 3:
  Model: handle_read("s_1", lines="5000-5200")
  → isFileStale: stat.mtimeMs > fileState.timestamp → 过时!
  → 回退: fs.readFileSync("big.ts") → 切片 → 返回最新内容
  → 附带 metadata: { from_cache: false, note: "File was modified..." }
```

### 3.3 模块职责

| 模块 | 职责 | 新增/修改 |
|---|---|---|
| `state.ts` | 缓存存储、脏检测、切片读取、snippet 恢复 | +96 行 |
| `handle-read-handler.ts` | handle_read 工具逻辑 | 新建 106 行 |
| `read-handler.ts` | Read 工具增加全量缓存 + snippet 元数据 | +27 行 |
| `session.ts` | 截断引导 + resume 恢复 | +9 行 |
| `prompt.ts` | handle_read 工具定义 | +26 行 |
| `executor.ts` | 注册 handler + 并行安全标记 | +3 行 |

---

## 四、关键设计决策

### 4.1 snippet 范围覆盖全缓存

```typescript
// read-handler.ts
const snippet = createSnippet(
  context.sessionId,
  filePath,
  1,               // ← 始终从第 1 行开始, 而非 textResult.startLine
  snippetEndLine,  // ← 全缓存范围, 而非 textResult.endLine
  preview
);
```

这确保 `handle_read("s_1", lines="8000-8100")` 能命中（即使 Read 只返回了前 2000 行），因为 snippet 的 endLine 是 10000。

### 4.2 截断提示的智能化

```typescript
// session.ts shrinkToolResult
const reFetchHint =
  typeof snippetId === "string"
    ? `use handle_read(snippet_id="${snippetId}", lines="X-Y") to fetch arbitrary ranges`
    : "use read_file to re-fetch if needed";
```

- 有 snippet_id → 引导 handle_read（精确、低成本）
- 无 snippet_id → 回退到 read_file（兼容旧行为）

### 4.3 Resume 时 Snippet 恢复

```typescript
// session.ts — 在 buildOpenAIMessages 之前
const sessionMessages = this.listSessionMessages(sessionId);
restoreSnippetsFromHistory(sessionId, sessionMessages);
```

扫描所有历史 tool_result 中的 snippet 元数据，重建 `snippetsBySession`。注意只重建**元数据**（id/filePath/startLine/endLine），不重建**文件内容**。文件内容在 handle_read 首次调用时通过 stale 检测自动回源。

### 4.4 10MB 全量缓存上限

```typescript
const MAX_FULL_CACHE_BYTES = 10 * 1024 * 1024; // 10MB
if (stat.size <= MAX_FULL_CACHE_BYTES) {
  cachedContent = fs.readFileSync(filePath, "utf8");
}
```

超过 10MB 的文件不做后台全量加载，只缓存 Read 实际返回的范围。这避免了加载大型日志文件、数据库导出文件时耗尽内存。

### 4.5 并行安全

`handle_read` 是纯内存操作（或简单的文件回源读取），不修改任何状态，标记为并行安全：

```typescript
private static readonly PARALLEL_SAFE_TOOLS = new Set([
  ...
  "handle_read",  // ← 纯内存操作，完全可并行
]);
```

---

## 五、成本分析

### 5.1 单 Turn 对比

```
场景：10000 行文件，模型需要看第 5000-5200 行

当前方式:
  Read("big.ts", offset=5000, limit=200) → 200 行 → ~11KB → 截断 → ~100 行
  如果还不够 → 再来一次 Read → 再截断

var_handle:
  Read("big.ts") → 全量缓存 → 返回前 2000 行 + snippet_id
  handle_read("s_1", "5000-5200") → 200 行 → ~6KB → 不截断
```

### 5.2 多 Turn 累计

```
模型探索大文件 5 个不连续区域，每区域 ~200 行

当前方式:  5 × 60KB = 300KB 累计上下文
var_handle: 1 × 60KB + 4 × 6KB = 84KB 累计上下文
节省: 72%
```

### 5.3 压缩阈值

```
当前方式:  约 13 轮后达到 800KB 触发压缩 → KV cache 全毁
var_handle: 约 120 轮后才达到 800KB → 几乎不触发压缩
```

### 5.4 内存成本

```
最坏情况: 10 个 session 各缓存 10 个 1MB 文件 = 100MB
典型情况: 1 个 session 缓存 3 个 100KB 文件 = 300KB
Session 结束后: 垃圾回收自动释放
```

---

## 六、与 DeepSeek TUI 的对比

| 维度 | DeepSeek TUI | 本项目 (var_handle) |
|---|---|---|
| Handle 类型 | 通用 var_handle (RLM/子Agent/文件) | 仅文件 Read |
| 缓存存储 | 未明示 | `fileStatesBySession` Map |
| 脏检测 | 无 (RLM 结果不可变) | mtime 文件时间戳 |
| Resume 恢复 | schema_version + 持久化 | JSONL 元数据扫描 |
| 安全上限 | 无 | 10MB |
| 复杂度 | ~3000 行 (含 RLM) | ~300 行 |

本项目采用了 DeepSeek TUI 的核心思想（句柄引用 + 按需读取），但在实现上做了大幅简化，去掉了 Python REPL、RPC 协议等重型依赖，仅针对文件读取这一最高频场景。

---

## 七、向后兼容性

| 旧行为 | 新行为 | 兼容性 |
|---|---|---|
| `Read("f.ts")` 返回 cat -n 文本 | 同, output 字段不变, 增加 metadata | ✅ |
| `shrinkToolResult` 截断 | 截断逻辑不变, 提示语优先引导 handle_read | ✅ |
| session 文件格式 | 不变 (snippet 信息通过 metadata 字段携带) | ✅ |
| 无 snippet_id 的旧会话 | `restoreSnippetsFromHistory` 跳过, 无副作用 | ✅ |

---

## 八、未来扩展方向

1. **Grep 结果 handle**：grep 匹配很多时, 返回 handle 而非截断列表
2. **Directory tree 结果 handle**：大项目目录列表返回 handle
3. **跨 session 文件缓存**：同一项目跨 session 复用文件缓存（需要 session_id 到 project 的映射）
4. **缓存压缩**：大文件缓存做 gzip 压缩以减少内存占用
5. **LRU 驱逐**：当前无上限, session 级别 LRU 可在长时间会话中控制内存
