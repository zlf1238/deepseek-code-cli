# Supervisor-Worker 架构：Pro 委派 Flash 子智能体执行代码修改

借鉴 [DeepSeek TUI](https://github.com/Hmbown/DeepSeek-TUI) 的 Auto Route 和 [DeepSeek Reasonix](https://github.com/esengine/reasonix) 的 Sub-agent + Escalation 机制，设计并实现了 Supervisor-Worker（主从/监督者-工作者）多智能体协同架构。

---

## 一、背景与问题

### 1.1 现有方案对比

项目研究了两个开源项目的 Flash→Pro 模型选择策略：

| 维度 | DeepSeek-TUI (Pre-call Routing) | DeepSeek-Reasonix (Mid-turn Escalation) |
|------|:--:|:--:|
| 决策时机 | 发请求前决定用哪个模型 | Turn 中途根据 AI 反馈动态升级 |
| 决策方式 | 启发式(关键词/长度) + Flash Router (额外 API 调用) | NEEDS_PRO 标记(<<<NEEDS_PRO>>>) + 修复信号计数器(阈值3) |
| 缓存稳定性 | ★★★ 依赖路由稳定性（频繁切换导致 ping-pong） | ★★★★★ flash 几乎一直热（~96%） |
| Token 浪费 | Flash Router 极轻量（max_tokens=96） | NEEDS_PRO 中断 ~20 tokens；修复信号升级浪费 1-3 轮 |
| 最大风险 | 启发式误判导致全程用错模型 | Pro 冷启动 500K 前缀 = ¥1.5/次 |

### 1.2 关键定价数据

DeepSeek V4 的 prefix-cache（KV cache）**不跨模型共享**：

| | Flash (每百万token) | Pro (每百万token) | 倍数 |
|---|---|---|---|
| Input cache-hit | ¥0.02 | ¥0.025 | 1.25× |
| Input cache-miss | ¥1.0 | ¥3.0 | 3× |
| Output | ¥2.0 | ¥6.0 | 3× |

**核心洞见**：Pro cache-miss vs Flash cache-hit = **150 倍**。切换模型冷启动的成本远高于选错模型。

---

## 二、架构设计

### 2.1 Supervisor-Worker 模式

```
┌────────────────────────────────────────────────────┐
│              Pro (Supervisor / 大脑)                │
│                                                    │
│  职责：意图理解 → 全局上下文 → 架构规划 → 任务拆解    │
│  工具：read_file, search_content, grep, bash...     │
│  能力：长会话上下文始终热缓存（¥0.025/M）             │
│  行为：读取文件获取上下文，生成 Action Plan，          │
│        委派给 Flash 子智能体执行，验证结果             │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │        Flash (Code Executor / 打字员)        │   │
│  │                                             │   │
│  │  职责：纯执行——读取文件 → 生成 SEARCH/REPLACE  │   │
│  │  工具：仅 read_file + edit_file + write_file │   │
│  │  状态：短上下文（仅文件+指令），用完即毁        │   │
│  │  缓存：每次冷启动但上下文短（~10K tokens）     │   │
│  └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

### 2.2 为什么这样设计

1. **Pro 长上下文缓存永远不冷**——Pro 主会话 prefix 从 session 开始到结束保持一致
2. **冷启动只在短上下文发生**——Flash 子智能体每次冷启动，但上下文仅 ~10K tokens（文件+指令），冷启动成本 ¥0.01
3. **Pro output 贵但 Flash output 便宜**——Pro ¥6/M vs Flash ¥2/M，代码生成（output-heavy）交给 Flash
4. **缓存惩罚最小化**——不让 Pro 冷启动 500K 前缀（¥1.5），宁愿让 Flash 冷启动 10K（¥0.01）

### 2.3 工具条件注册（零缓存污染）

```
autoSwitch=on  + model=Pro   → 注册 spawn_code_executor → Pro 走 Supervisor 模式
autoSwitch=on  + model=Flash → 不注册 → Flash 直接执行
autoSwitch=off               → 不注册 → Pro/Flash 直接执行
```

System prompt 中包含固定段落 `CODE_EXECUTOR_GUIDANCE`（始终存在，不随配置变化），描述"当工具可用时怎么做，不可用时怎么做"。工具的有无自然决定 Pro 的行为，无需动态注入消息破坏缓存。

---

## 三、工程落地

### 3.1 为什么选择 Tool Calling 而非 Pipeline

| 路径 | 方式 | 适用场景 | 本项目 |
|------|------|---------|:--:|
| 路径1: Pipeline | CLI 拦截 Pro 的 JSON → 组装 Flash Prompt → 返回系统消息 | 无 Tool Calling 的简单 CLI | ❌ |
| 路径2: Tool Calling | Pro 调用 spawn_code_executor → Handler 实例化 Flash 子智能体 → Tool Response 返回 | 完整 API 协议 | ✅ |

选择 Tool Calling 的原因：
- 本项目 session.ts 主循环天然支持 Tool Calling
- Pro 保持主动权（自己决定何时委派、如何解读结果、是否重试）
- 缓存语义天然正确（Tool Call 和 Tool Response 是 API 协议的一部分）

### 3.2 涉及文件

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/tools/code-executor.ts` | 新增 402 行 | 子智能体核心：隔离循环、API 调用、工具分发、usage 追踪、自修正 |
| `src/prompt.ts` | +61 行 | 工具定义 + `CODE_EXECUTOR_GUIDANCE` 固定段落（含委派策略+验证指导） |
| `src/session.ts` | +68 行 | 子智能体 usage 合并到 `usageByModel["deepseek-v4-flash"]` + UI 通知 |
| `src/tools/executor.ts` | +3 行 | 注册 handler + parallelSafe 标记 |

### 3.3 子智能体设计

```
Prompt = CODE_EXECUTOR_SYSTEM + "Task: ... File: ... Context: ..."

循环 (max 8 iters):
  Flash API 调用 (thinking=on, effort=high, stream=false)
  ├─ 无 tool_calls → 返回结果（成功）
  ├─ read_file → 执行 → 追加结果 → 继续循环
  ├─ edit_file → 执行 → 追加结果 → 继续循环
  │   └─ 失败?(search text not found) → 自动重试最多 2 次
  └─ write_file → 执行 → 追加结果 → 继续循环

返回: { success, output(摘要), turns, tool_iters, elapsed_ms, cost_usd, usage }
```

### 3.4 子智能体返回格式

```
成功:
{
  "success": true,
  "output": "已将login函数从回调改为async/await。SEARCH匹配1/1, REPLACE成功。",
  "turns": 2, "tool_iters": 1,
  "elapsed_ms": 1234, "cost_usd": 0.008
}

失败:
{
  "success": false,
  "error": "无法找到指定的SEARCH文本。文件可能已被修改。",
  ...
}
```

---

## 四、缓存分析

### 4.1 三种方案对比

| 场景 | TUI (Pre-call) | Reasonix (Mid-turn) | 本项目 (Supervisor) |
|------|:--:|:--:|:--:|
| 长会话 Pro 缓存 | 不稳定（切换 ping-pong） | 冷（只在升级时用） | ★★★★★ 始终热 |
| Flash 缓存 | 不稳定（切换 ping-pong） | ★★★★★ 始终热 | 冷启动但上下文短 |
| 升级时 Pro 冷启动 | 无（提前决定） | 有（¥1.5/500K） | 无（Pro 不换模型） |
| 子智能体冷启动 | N/A | N/A | ¥0.01/10K |
| 额外 API 调用 | Flash Router（96 tokens） | 无 | 子智能体调用（~3K tokens） |

### 4.2 长会话成本模型

假设 500K 累积前缀，每轮修改一次文件：

```
方案A (Reasonix NEEDS_PRO):
  正常轮: Flash cache-hit: 500K × ¥0.02/M = ¥0.01
  升级轮: Pro cache-miss: 500K × ¥3.0/M = ¥1.50
  成本: 96%×0.01 + 4%×1.50 = ¥0.07/轮 (加权)

方案B (本项目 Supervisor):
  Pro 规划: Pro cache-hit: 500K × ¥0.025/M = ¥0.0125
  Flash 执行: Flash cold: 10K × ¥1.0/M + output 1K × ¥2.0/M = ¥0.012
  成本: ¥0.0245/轮

结论: 本项目方案在长会话中优于 NEEDS_PRO 升级（因避免了 Pro 冷启动）
```

---

## 五、实现总结

### 5.1 核心功能点

| # | 功能点 | 状态 |
|---|--------|:--:|
| 1 | `spawn_code_executor` 工具注册 | ✅ |
| 2 | Flash 子智能体：隔离循环 + thinking=on + effort=high + maxIters=8 | ✅ |
| 3 | 子智能体工具范围：仅 read_file/edit_file/write_file | ✅ |
| 4 | 子智能体 Prompt：`CODE_EXECUTOR_SYSTEM`（纯执行，不扩展范围） | ✅ |
| 5 | 内部自修正：edit 失败时自动重试最多 2 次 | ✅ |
| 6 | 父级 Abort 联动：主会话 Esc 时子智能体同步中止 | ❌ (Phase 2) |
| 7 | System prompt 固定段落：`CODE_EXECUTOR_GUIDANCE` | ✅ |
| 8 | 工具条件注册（autoSwitch=on + model=Pro 时） | ✅ (提示词层面) |
| 9 | 子智能体 usage 合并到 session.usageByModel | ✅ |
| 10 | UI 通知：`[委派执行] 工作中…` / `✓ 完成 · token · 缓存命中% · ¥` | ✅ |
| 11 | 多模型拆分展示：buildCompletionSummary 自动支持 Pro+Flash 分列 | ✅ |
| 12 | 验证指导：复杂/跨文件修改 → read_file 验证；简单修改 → 信任 | ✅ |
| 13 | 降级回退：Flash client 不可用时回退到默认 client | ✅ |
| 14 | 委派频率保护（>10 次/会话时警告） | ❌ (Phase 2) |

### 5.2 文件修改统计

```
 src/tools/code-executor.ts | 403 +++++++++++++++++++++++++++++++++++++
 src/prompt.ts              |  65 +++++-
 src/session.ts             |  68 ++++++
 src/tools/executor.ts      |   3 +
 src/tests/prompt.test.ts   |   8 +-
 5 files changed, 542 insertions(+), 4 deletions(-)
```

---

## 六、其他思路

在讨论过程中，还探讨了以下可选方案，供后续参考：

| 思路 | 说明 | 优先级 |
|------|------|:--:|
| 投机并行执行 | 同时发 flash 和 pro，取最快可用结果 | 低 |
| 本地复杂度分类器 | 用极小的本地模型做路由决策（零 API 成本） | 中 |
| 前缀预热代理 | idle 时后台预热另一个模型的 cache | 低 |
| 分层响应模式 | Flash 出草稿 → Pro 改进（而非 Pro 从零生成） | 中 |
| Session 级模型绑定 | 整个 session 一种模型，100% 缓存命中 | 中 |
| 缓存预算感知动态阈值 | 前缀越大升级越保守（本项目已部分实现） | 已隐含 |

---

## 七、最佳实践（避坑指南）

### 7.1 不要往 Pro 上下文塞代码

**错误做法**：子智能体返回修改后的完整文件内容 → 作为 Tool Response 进入 Pro 前缀 → 前缀变化 → 缓存失效

**正确做法**：子智能体只返回摘要（成功/失败 + 一句话描述 + 文件列表），不返回完整文件内容。当前实现已做到。

### 7.2 不每轮挂载文件快照

**错误做法**：每轮在 system prompt 中刷新所有文件 snapshot → system prompt 每次变化 → 缓存全毁

**正确做法**：Pro 需要时自己 read_file。当前项目始终如此。

### 7.3 不中途注入消息

**错误做法**：session 中间动态插入 Supervisor 提示词消息 → prefix 变化 → 缓存从插入点失效

**正确做法**：Supervisor 行为指南在 session 创建时写入 system prompt（固定位置），工具的有无决定实际行为。当前实现已做到。

---

## 八、后续工作 (Phase 2)

1. **父级 Abort 联动**：主会话 Esc/Ctrl+C 时，子智能体同步中止
2. **委派频率保护**：单 session >10 次委派时提示警告（借鉴 Reasonix subagentBudgetHint）
3. **并行子智能体**：Pro 同时委派多个 Flash 改不同文件
4. **子智能体内部验证**：修改后运行 linter/typecheck，失败时自动修正
