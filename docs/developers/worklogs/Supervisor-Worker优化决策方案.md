# Supervisor-Worker 优化决策方案

本文档记录 Supervisor-Worker 架构在首次实现后，经过实际使用与 Aider Architect/Editor 模式对比分析，所做的一系列优化决策。

---

## 一、问题背景

### 1.1 对比对象

[Aider](https://github.com/Aider-AI/aider) 的 Architect/Editor 模式与本项目 Supervisor/Worker 模式的核心差异：

| 维度 | Aider Architect/Editor | 本项目 Supervisor/Worker（优化前） |
|------|----------------------|----------------------------------|
| 两阶段关系 | 串行：Architect 完成 → 用户确认 → Editor 启动 | 嵌套：Supervisor 循环中调用 spawn 工具 |
| 中间确认 | 有人工确认 | 无，直接委派 |
| Architect 产出 | 自然语言指令 | 结构化 task + file_path + context |
| Editor 工具 | SEARCH/REPLACE + 可能 shell | 仅 read/edit/write |
| 编辑器模型 | 可独立配置 editor_model | 固定 Flash |
| Prefix-cache | 无特殊保护 | 隔离上下文保护 Supervisor 缓存 |

### 1.2 实际使用暴露的问题

经过多轮实际使用，发现以下问题：

| # | 问题 | 严重度 |
|---|------|:------:|
| 1 | `file_path` 仅支持单文件，跨文件需多次 spawn，子智能体上下文割裂 | 高 |
| 2 | Flash 开 thinking 时 API 报 400：`reasoning_content` 未回传 | 高 |
| 3 | thinkingEnabled 硬编码 true，无法按任务选择 | 中 |
| 4 | spawn 失败时费用为 0，无法追踪 | 中 |
| 5 | `normalizeSessionEntry` 漏掉 `usageByModel`，模型明细始终为空 | 高 |
| 6 | `resolveModelPricing` 未清 `env.MODEL`，Flash 费算成 Pro 价 | 高 |
| 7 | 总费用只用 Pro 费率算汇总 token，未累加各模型实际费用 | 中 |
| 8 | context 字段完全可选，Supervisor 经常不填，子智能体因缺上下文失败 | 高 |
| 9 | spawn 失败只有 error 字符串，Supervisor 无法按类型决策 | 中 |
| 10 | 子智能体工具集不可配置，搜索类任务无法完成 | 中 |
| 11 | 无高风险操作确认机制，Supervisor 有时越权操作 | 低 |
| 12 | spawn 没有节省对比，用户感知不到 Flash 的价值 | 低 |
| 13 | 模型明细单行过长（Pro+Flash 拼在一行） | 低 |

---

## 二、决策思路

### 2.1 为什么不用 Aider 的串行确认模式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. Aider 模式 | Architect 输出后用户确认 → Editor 执行 | 安全，用户可控 | 两次 LLM 调用 + 用户等待，延迟高 |
| B. 嵌套模式（保持） | Supervisor 对话中调用 spawn | 延迟低，可并行多 spawn | 无人工确认环节 |
| C. 混合模式 | 嵌套 + 高风险时 AskUserQuestion | 兼得 | 略增复杂度 |

**选 C 的理由**：保持嵌套模式低延迟优势，对跨文件重构、大删改等高风险操作，Supervisor 调用已有的 `AskUserQuestion` 工具先确认再 spawn。

### 2.2 为什么 `enable_thinking` 默认 true 而非 false

| 选项 | 理由 |
|------|------|
| 默认 false | 省 token，但子智能体修改多文件时需要推理跨文件一致性，不开 thinking 易出错 |
| 默认 true | 子智能体修改质量更高，`reasoning_content` 回传 bug 修复后无副作用 |

**选默认 true**。对机械替换任务，Supervisor 可传 `enable_thinking=false` 节省 token。

### 2.3 为什么失败码用字符串枚举而非数字

```
数字码  → NOT_FOUND=1, AMBIGUOUS=2 ...  → Supervisor 记不住映射
字符串  → "NOT_FOUND", "AMBIGUOUS"      → 自解释
```

选字符串枚举 `SubagentFailureCode`，Supervisor prompt 中可直接引用分类码做出决策。

### 2.4 为什么 context 不用结构化字段

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 结构化 JSON | `{ type_defs: [...] }` | 类型安全 | 模型不擅长构造嵌套 JSON |
| B. 自由文本 + 约束 | 字符串 + prompt 约束 | 模型友好 | 可能过少或过多 |

**选 B**，通过 prompt 约束（"只传必需的类型和签名，不要粘贴完整文件"）来平衡。

---

## 三、架构设计

### 3.1 spawn_code_executor 参数演进

```
优化前:
  task: string          // 修改指令
  file_path: string     // 单文件路径
  context: string       // 可选上下文

优化后:
  task: string                    // 修改指令
  file_paths: string[]            // 多文件路径（向后兼容 file_path）
  context: string                 // 上下文（涉及外部类型时强制提供）
  enable_thinking: boolean        // 开关思考模式（默认 true）
  allowed_tools: string[]         // 子智能体工具集（默认 read+edit+write）
  require_confirmation: boolean   // 是否要求执行前确认（待 session 层实现）
```

### 3.2 子智能体 reasoning_content 回传

```
┌──────────────────────────────────────────────────────────┐
│ Flash 子智能体消息循环                                     │
│                                                          │
│ system: CODE_EXECUTOR_SYSTEM                              │
│ user: task + files + context                              │
│                                                          │
│   ↓ API call (thinking=enabled)                          │
│                                                          │
│ assistant: { content, tool_calls, reasoning_content }     │
│   → 提取 reasoning_content                                │
│   → 下次 push assistant 消息时回传 reasoning_content       │
│                                                          │
│   ↓ API call (带 reasoning_content)                      │
│                                                          │
│ assistant: { content } → 无 tool_calls → 完成             │
└──────────────────────────────────────────────────────────┘
```

### 3.3 失败码流程

```
handleCodeExecutorTool 错误返回
  → metadata.failureCode: "API_ERROR" | "NOT_FOUND" | "AMBIGUOUS" | ...
    → session.ts 检查 execution.result.ok === false
      → 展示: [委派执行] ✗ 失败 · API错误 · <原始错误信息>

Supervisor 收到失败通知后按策略应对:
  NOT_FOUND / AMBIGUOUS → 重新阅读文件，补充 context，再次 spawn
  API_ERROR             → 重试一次
  TIMEOUT / SCOPE_EXCEEDED → 自己直接修改
```

### 3.4 多模型费用计算链路

```
session.usageByModel = {
  "deepseek-v4-pro": { prompt_tokens: ..., completion_tokens: ..., ... },
  "deepseek-v4-flash": { prompt_tokens: ..., completion_tokens: ..., ... }
}

buildCompletionSummary:
  1. 按模型遍历 usageByModelDiff
  2. resolveModelPricing(modelName) → 获取该模型的费率
  3. 各模型按各自费率计算费用
  4. sumModelCost = Σ(modelCost)
  5. 展示: 费用: ¥0.019 · 模型明细: Flash: ¥0.0057 + Pro: ¥0.013
```

**关键修复**：
- `normalizeSessionEntry` 反序列化时添加 `usageByModel` 字段
- `resolveModelPricing` 清空 `env.MODEL` 确保用 override model 的费率
- 总费用改用 `sumModelCost` 而非 aggregate tokens × Pro 费率

---

## 四、实现细节

### 4.1 向后兼容：file_path 回退

```typescript
// 优先 file_paths 数组，回退到 file_path 单字符串
const filePaths: string[] = (() => {
  const arr = args.file_paths;
  if (Array.isArray(arr)) return arr.map(x => ...).filter(...);
  const single = args.file_path;
  if (typeof single === "string" && single.trim()) return [single.trim()];
  return [];
})();
```

### 4.2 比Pro节省计算

```typescript
// 在 spawn 完成消息中展示节省
const proCost = calculateWithPricing(sUsage, proPricing);  // 同 token 用 Pro 费率
const saved = proCost - sCostUsd;
savingsStr = ` · 比Pro节省 ¥${saved} (${pct}%)`;
```

### 4.3 模型明细分行

```typescript
// 不再通过 parts.join(" · ") 拼模型明细，而是独立拼接到 content 尾部
content = parts.join(" · ") + modelDetailLine;
// modelDetailLine = "\n · 模型明细: Flash: ... + Pro: ..."
```

### 4.4 子智能体工具集条件构建

```typescript
function getSubagentTools(allowedTools?: string[]) {
  const toolSet = new Set(allowedTools ?? ["read_file", "edit_file", "write_file"]);
  const tools = [];
  if (toolSet.has("read_file")) tools.push(/* ... */);
  if (toolSet.has("edit_file")) tools.push(/* ... */);
  if (toolSet.has("write_file")) tools.push(/* ... */);
  if (toolSet.has("grep")) tools.push(/* ... */);
  return tools;
}
```

---

## 五、文件修改统计

### 第一批：跨文件委派 + reasoning 回传 + 参数可控 + 错误路径 cost

```
 src/tools/code-executor.ts | ±82 行 (重构消息循环、参数解析、error 路径)
 src/prompt.ts              | ±13 行 (file_paths 参数、enable_thinking 参数)
 2 files changed
```

### 第二批：序列化修复 + 费率修复 + 总费用 + savings + 分行

```
 src/session.ts             | ±50 行 (normalizeSessionEntry 补字段、savings 计算)
 src/ui/App.tsx             | ±40 行 (resolveModelPricing 清 env、sumModelCost、分行)
 2 files changed
```

### 第三批：失败码 + context + 工具可配 + prompt 优化

```
 src/tools/code-executor.ts | ±80 行 (failureCode 定义及所有错误返回点、getSubagentTools 重构)
 src/prompt.ts              | ±25 行 (context 约束、require_confirmation、allowed_tools、GUIDANCE 重写)
 src/session.ts             | ±20 行 (failureCode 展示)
 3 files changed
```

### 总计

```
 src/tools/code-executor.ts | 核心改动 ~160 行
 src/prompt.ts              | ~40 行
 src/session.ts             | ~70 行
 src/ui/App.tsx             | ~40 行
 4 files, ~310 行增量
```

---

## 六、与 Aider 的最终对比

| 维度 | Aider Architect/Editor | 本项目 Supervisor/Worker（优化后） |
|------|----------------------|----------------------------------|
| 两阶段关系 | 串行：完成→确认→执行 | 嵌套 spawn + 高风险 AskUserQuestion |
| 中间确认 | 每次确认 | 仅高风险确认 |
| 子智能体上下文 | 完整对话历史 | 隔离 + task + context（强制要求） |
| 子智能体工具 | 较宽 | 默认最小 + 可配置扩展（allowed_tools） |
| 编辑器模型 | 每模型独立配置 | 固定 Flash（P3 计划可选化） |
| 失败处理 | 无结构化 | failureCode 分类 + 策略指导 |
| 费用可视化 | 合并显示 | 按模型分列 + 比Pro节省 |
| Prefix-cache | 无保护 | 隔离上下文保护 |

---

## 七、后续工作 (Phase 3)

1. **Flash 模型可选化**：允许用户在 settings 中配置替代 Flash 的模型
2. **并行 spawn**：无依赖的独立文件修改，多 spawn 并发
3. **子智能体注入上下文自动化**：从 task 提取符号名 → 自动 grep → 注入 context
4. **require_confirmation session 层实现**：tool call 重入 + 确认状态追踪
5. **spawn 结果缓存**：相同 task+file 的 spawn 结果缓存，避免重复 API 调用
