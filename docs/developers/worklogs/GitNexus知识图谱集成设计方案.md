# GitNexus 知识图谱集成设计文档

## 一、问题背景

### 1.1 当前瓶颈

LLM 在理解代码库结构时效率低下：

| 瓶颈 | 位置 | 影响 |
|---|---|---|
| **逐文件探索** | LLM 调用 `glob` → `grep` → `read` 循环 | 多次往返才能定位目标代码 |
| **无全局视角** | 每个 `read` 只能看到单个文件 | 无法一次了解模块间依赖关系 |
| **变更盲目** | 修改代码前无法预知影响面 | 可能遗漏被影响的文件 |
| **重复探索** | 每次新会话重新 grep/read | Token 浪费在重复的文件探索上 |

**示例对比**：

```
无知识图谱:
  LLM: glob("**/*.ts") → 100 个文件
  LLM: grep("authenticate") → 12 处匹配
  LLM: read("auth.ts") → 一个文件
  LLM: read("session.ts") → 另一个文件
  LLM: grep("SessionManager") → 再搜索
  ... 循环往复，每次消耗 token 和时间

有知识图谱:
  LLM: gitnexus_context("SessionManager")
    → 定义位置、所有调用方、所有 import 方、参与的进程
    → 一次调用完成
```

### 1.2 与 aider RepoMap 对比的差距

aider 内置 RepoMap，每次对话自动注入代码库结构。本项目此前不具备此能力，LLM 在理解项目结构时全靠手动工具组合，效率不高。

---

## 二、决策思路

### 2.1 为什么选择 GitNexus 而非自建

考察了三个方案：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 自建 tree-sitter 图谱 | 用 `ts-morph` 解析 TS → 构建调用图 | 完全可控 | 开发成本极高（>2000行），需处理多语言 |
| B. 借鉴 aider RepoMap | 翻译 Python→TypeScript，PageRank 算法 | 成熟方案 | 翻译工作量大，仅输出文本 Map |
| C. 集成 GitNexus MCP | 通过 MCP 协议调用外部知识图谱引擎 | **零开发负担**，功能最丰富 | 依赖外部进程，首次需安装 |

**选 C 的理由**：

1. GitNexus 已解决所有困难问题：tree-sitter 解析、图构建、聚类、搜索、影响分析
2. 与项目同语言栈（TypeScript），无需跨语言 FFI
3. MCP 协议标准化，一次集成即可复用 12+ 工具和 7+ 资源
4. 社区活跃（37k+ stars），持续维护
5. 本项目通过 `npx -y gitnexus@latest` 自动安装，用户零配置

### 2.2 为什么是 5 个工具而不是全部 16 个

GitNexus 提供 16 个 MCP 工具，本项目精选 5 个核心工具：

| 工具 | 选择理由 | 未选工具 |
|---|---|---|
| `gitnexus_query` | 混合搜索，定位代码最常用 | `detect_changes` — 过于细分 |
| `gitnexus_context` | 360° 符号视图，理解上下游 | `rename` — 用 `edit` + `multi_edit` 替代 |
| `gitnexus_impact` | 变更前评估影响面 | `cypher` — LLM 不擅长写图查询 |
| `gitnexus_clusters` | 快速理解项目分层 | `route_map` — 仅后端项目有用 |
| `gitnexus_processes` | 调试时追踪调用链 | `api_impact` — 过于细分 |

**原则**：工具越多 LLM 选择困难越大。5 个工具覆盖 80% 场景，多余的留给未来按需添加。

### 2.3 MCP 通信方式选择

| 方式 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 长连接 | 维持一个 `gitnexus mcp` 进程，JSON-RPC 复用 | 低延迟 | 需处理重连、心跳、进程管理 |
| B. 一次性调用 | 每次工具调用 spawn 新进程 | 零状态管理 | 每次需重新初始化 |
| **C. 懒长连接** | 会话期间维持连接，空闲超时释放 | 平衡延迟和复杂度 | — |

当前实现采用 **B（一次性调用）**，理由：
- 首次实现，优先稳定性
- 每次调用 `query`/`context` 需 3-10 秒，初始化开销仅 ~1 秒
- 避免 MCP 进程泄漏影响用户终端
- 后续可升级到方案 C

### 2.4 Token 预算感知截断

借鉴 aider RepoMap 的 `max_map_tokens` 设计，每个工具支持 `max_chars` 参数：

```
默认截断: 8000 字符 (约 2000 token)
超限策略: 头尾各保留一半，中间提示 "… (truncated X chars)"
模型补救: 可用 max_chars 参数调大，或用 gitnexus_context 查看单个符号
```

---

## 三、架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    deepseek-code-cli                         │
│                                                              │
│  SessionManager ──→ ToolExecutor ──→ gitnexus-handler.ts     │
│       │                  │                    │               │
│       │          注册 5 个 handler    ┌───────┴──────────┐   │
│       │                              │                    │   │
│  启动时后台索引     ┌─────────────────┤  GitnexusMCPOneShot │   │
│       │            │                 │  (JSON-RPC 客户端)  │   │
│       ▼            ▼                 └────────┬─────────┘   │
│  ensureGitnexus  ensureIndex                   │              │
│  IndexAsync()    (首次调用时)              stdin/stdout       │
│       │                                    │                 │
│       └────────── npx gitnexus ────────────┘                 │
│                  analyze | mcp                                │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 索引生命周期

```
会话启动
  │
  ├─ ensureGitnexusIndexAsync()     ← 后台静默，不阻塞
  │    ├─ .gitnexus/ 存在且未过期 → 跳过
  │    └─ 否则 → spawn npx gitnexus analyze
  │
  ├─ 首次调用任一 gitnexus 工具
  │    └─ ensureIndex()             ← 同步等待（有锁防并发）
  │         ├─ 已索引 → 立即返回
  │         └─ 未索引 → spawn npx gitnexus analyze (2min timeout)
  │
  └─ 30 分钟后再次调用
       └─ ensureIndex() → 检测过期 → 自动重建
```

过期检测：`.gitnexus/` 目录 mtime > 30 分钟前 → 触发重建（`maxIndexAgeMinutes` 可配）。

### 3.3 MCP 通信流程

```
GitnexusMCPOneShot.callTool("query", { query: "auth", limit: 3 })
  │
  ├─ 1. spawn("npx", ["-y", "gitnexus@latest", "mcp"])
  ├─ 2. stdin ← initialize request
  ├─ 3. stdout → initialize response
  ├─ 4. stdin ← notifications/initialized
  ├─ 5. stdin ← tools/call {"name":"query","arguments":{...}}
  ├─ 6. stdout → tools/call response
  ├─ 7. stdin.end() + kill()
  └─ 8. return extractToolResult(response)

GitnexusMCPOneShot.readResource("gitnexus://repo/{name}/clusters")
  │
  ├─ 1-4 同上
  ├─ 5. stdin ← resources/read {"uri":"gitnexus://..."}
  ├─ 6. stdout → resources/read response
  │     注意: 格式为 result.contents[0].text (非 result.content)
  └─ 7-8 同上
```

### 3.4 仓库名自动检测

```
getRepoName()
  ├─ 已缓存 → 直接返回
  └─ 调用 list_repos MCP 工具
       ├─ 匹配 projectRoot 路径 → 返回 repo.name
       └─ 无匹配 → 返回 path.basename(projectRoot)
```

---

## 四、实现细节

### 4.1 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/tools/gitnexus-handler.ts` | 411 | MCP 客户端 + 索引管理 + 5 个 handler |
| `src/prompt.ts` | +119 | 5 个工具定义（JSON Schema） |
| `src/tools/executor.ts` | +10 | 注册 handler + 标记并行安全 |
| `src/settings.ts` | +8 | GitnexusConfig 配置类型 |
| `src/session.ts` | +4 | 启动时后台索引 |

### 4.2 并发索引锁

```typescript
const INDEX_LOCK = new Map<string, Promise<{ ok: boolean; error?: string }>>();

async function ensureIndex(projectRoot, context) {
  // 避免多个 LLM 工具调用同时触发索引
  const existing = INDEX_LOCK.get(projectRoot);
  if (existing) return existing;
  // ...
}
```

### 4.3 MCP 响应格式差异

| 请求类型 | MCP Method | 响应字段 |
|---|---|---|
| 工具调用 | `tools/call` | `result.content[0].text` |
| 资源读取 | `resources/read` | `result.contents[0].text` |

通过 `pendingType` 字段路由到 `extractToolResult` 或 `extractResourceResult`。

### 4.4 并行安全

所有 5 个 GitNexus 工具都是只读查询，标记为并行安全：

```typescript
private static readonly PARALLEL_SAFE_TOOLS = new Set([
  // ...
  "gitnexus_query", "gitnexus_context", "gitnexus_impact",
  "gitnexus_clusters", "gitnexus_processes",
]);
```

但注意：每个工具调用需等待索引完成（互斥锁），实际并行受益有限。

---

## 五、成本分析

### 5.1 首次使用成本

| 阶段 | 耗时 | 说明 |
|---|---|---|
| npx 下载 gitnexus | 10-30s | 仅首次，之后使用 npm 缓存 |
| analyze 索引 | 30-80s | 视项目规模（本项目 91 文件 → 58s） |
| MCP 初始化 | ~1s | 仅首次连接 |

### 5.2 每次调用成本

| 工具 | 典型耗时 | 典型 Token 消耗 |
|---|---|---|
| `query` | 3-10s | 输出 ~2-3K 字符（截断后） |
| `context` | 1-3s | 输出 ~1-2K 字符 |
| `impact` | 5-15s | 输出 ~2-4K 字符 |
| `clusters` | 1-2s | 输出 ~500 字符 |
| `processes` | 1-3s | 输出 ~1-3K 字符 |

### 5.3 Token 节省对比

```
场景：LLM 需要理解认证模块的调用链（涉及 5 个文件间的关系）

无 GitNexus:
  grep("authenticate") → 3K 输出
  read("auth.ts")      → 8K 输出
  read("session.ts")   → 10K 输出
  grep("createSession") → 2K 输出
  read("db.ts")        → 6K 输出
  合计: 29K token 输入（5 轮工具调用）

有 GitNexus:
  gitnexus_query("auth session") → 3K 输出
  gitnexus_context("authenticate") → 2K 输出
  合计: 5K token 输入（2 轮工具调用）

节省: 83%
```

### 5.4 内存成本

```
索引存储: .gitnexus/ 目录 ~10-50MB（LadybugDB）
运行时: MCP 进程 ~50MB（仅调用时存在）
本进程: Map 缓存 < 1KB（仅索引锁 + 仓库名字符串）
```

---

## 六、与 aider RepoMap 的对比

| 维度 | aider RepoMap | 本项目 GitNexus 集成 |
|---|---|---|
| 语言 | Python | **TypeScript**（同语言栈） |
| 集成方式 | 内置，零配置 | MCP 外部进程，首次 npx 安装 |
| 输出形式 | 纯文本代码地图 | 结构化 JSON/文本，支持多种查询 |
| 算法 | PageRank 排序 | Leiden 社区检测 + BM25 + 语义搜索 |
| 功能深度 | 定义/引用图 | 知识图谱 + 聚类 + 进程追踪 + 影响分析 |
| 自动刷新 | 每次对话自动注入 | 30 分钟过期检查后自动重建 |
| Token 预算 | 内置 max_map_tokens | 每个工具 `max_chars` 参数 |
| 安装依赖 | Python pip | Node.js npx（已具备） |
| 代码量 | 868 行 Python | 411 行 TypeScript（handler）+ 119 行（定义） |

---

## 七、验证方法

### 7.1 安装验证

```bash
# 安装（需 Node.js ≥ 18）
npm install -g gitnexus

# 索引项目
cd your-project && gitnexus analyze

# 确认索引成功
ls .gitnexus/
```

### 7.2 功能验证

在 deepseek-code TUI 中输入以下 prompt 观察 LLM 是否调用 GitNexus 工具：

```
使用 gitnexus_clusters 列出本项目的功能模块
使用 gitnexus_context 分析 SessionManager 的调用关系
使用 gitnexus_impact 检查修改 bash-handler.ts 的影响面
```

观察步骤指示器是否出现 `[gitnexus_query ...]` 等提示。

### 7.3 故障排查

| 症状 | 原因 | 解决 |
|---|---|---|
| "gitnexus: command not found" | npm 全局路径未加入 PATH | `export PATH="$(npm prefix -g)/bin:$PATH"` |
| 索引失败无输出 | onnxruntime 下载超时 | `npm install -g --ignore-scripts gitnexus` |
| "Unknown tool" | handler 参数名不匹配 | 检查 `args.name`/`args.target` 是否正确 |

---

## 八、未来扩展方向

1. **MCP 长连接优化**：维持一个持久 `gitnexus mcp` 进程，消除初始化开销
2. **跨模型架构师模式**：用 gitnexus 知识图谱增强 `spawn_code_executor` 子智能体上下文
3. **自动 Context 注入**：借鉴 RepoMap，每次对话自动注入项目聚类概览到 system prompt
4. **增量索引**：仅在 git commit 后增量更新图谱，减少全量重建频率
5. **跨仓库查询**：支持 `group_*` 工具，分析微服务间依赖
6. **PR 影响分析**：集成 `detect_changes` 工具，PR 审查前自动评估影响面
7. **Skill 自动生成**：用 `gitnexus analyze --skills` 为每个功能模块生成 SKILL.md
