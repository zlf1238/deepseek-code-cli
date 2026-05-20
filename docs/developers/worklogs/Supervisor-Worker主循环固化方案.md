# Supervisor-Worker 主循环固化：Pro 热缓存 + Flash 子智能体

在[Supervisor-Worker架构设计方案](./Supervisor-Worker架构设计方案.md) 的基础上，针对主循环 Pro↔Flash 切换导致的缓存污染问题进行彻底修复：**主循环固定 Pro（热缓存），代码修改全量委派 Flash 子智能体（隔离上下文）**。

---

## 一、问题发现

### 1.1 震荡现象

实际运行日志暴露了主循环切换的严重问题：

```
[模型切换] -0.2 轮回本 → 切换到 Flash
[模型切换] 复杂度分数=3, 3种工具, Flash已运行5轮 → 升级到 Pro
[模型切换] -2.4 轮回本 → 切换到 Flash
[模型切换] 复杂度分数=3, 5种工具, Flash已运行5轮 → 升级到 Pro
[模型切换] -5.9 轮回本 → 切换到 Flash
[模型切换] 复杂度分数=3, 6种工具, Flash已运行5轮 → 升级到 Pro
[模型切换] -11.0 轮回本 → 切换到 Flash
```

**三层反馈回路同时闭合**：

| 回路 | 根因 | 机制 |
|------|------|------|
| A | `uniqueTools` 只增不减，≥3永久锁定+2分 | `decideFlashToPro` 信号2 |
| B | `roundsOnFlash≥5` 每次+1分，阈值仅需3分 | 2+1=3≥3 → 必触发 |
| C | `switchPenalty` 恒为负（Flash miss=1.0 < Pro expected=1.5125） | Pro→Flash "白赚" |

### 1.2 成本反直觉

测算 200K 上下文、100 次 API 请求、10 次用户交互：

| 策略 | 成本 | vs 纯Pro |
|------|------|:--:|
| 纯 Pro | ¥4.68 | 基线 |
| 当前代码（Pro↔Flash 震荡） | **¥10.45** | **+123%** |
| Pro 热缓存 + Flash 子智能体 | **¥4.40** | **-6%** |

**震荡比纯 Pro 贵 2.2 倍**，原因：

```
纯 Pro (h=0.95):
  100次 × 100K avg input × ¥0.0339/M(加权) = ¥0.34
  200K output × ¥6.0/M = ¥1.20
  合计 ¥4.68

震荡 (h 被污染到 0.50):
  Pro 10次 × 100K × ¥0.3025/M(加权) = ¥3.03  
  Flash 90次 × 100K × ¥0.0756/M(加权) = ¥6.80
  output = ¥0.62
  合计 ¥10.45  ← Pro的缓存每次回归都被Flash污染
```

---

## 二、解决方案

### 2.1 架构决策

| | 旧方案 | 新方案 |
|---|---|---|
| 主循环模型 | Pro→Flash 双向切换 | **固定 Pro** |
| 修改执行 | Flash 接管主循环 | **Flash 子智能体隔离** |
| Pro prefix-cache | 每次切换污染，h 跌到 0.5 | **始终热，h≈0.95** |
| 子智能体缓存 | — | 每次冷启动 10K tokens，¥0.01 |
| 成本模型 | output 省钱 input 亏钱 | **input/output 双赢** |

### 2.2 架构图

```
┌──────────────────────────────────────────────────┐
│              Pro 主循环（始终热缓存）              │
│  read_file → grep → 分析 → 输出修改方案            │
│    │                                             │
│    ├─ 简单修改(≤5行) → edit_file 直接改            │
│    │                                             │
│    └─ 复杂修改(>5行/跨文件)                        │
│         │                                         │
│         ▼                                         │
│    spawn_code_executor                            │
│         │                                         │
│         ▼                                         │
│    ┌─────────────────────────────┐               │
│    │  Flash 子智能体（隔离上下文）  │               │
│    │  system: CODE_EXECUTOR       │               │
│    │  tools: read+edit+write      │               │
│    │  context: ~10K tokens        │               │
│    │  冷启动 ¥0.01/次              │               │
│    │  不改 Pro 缓存                │               │
│    │  自修正重试(最多2次)           │               │
│    └──────────────┬──────────────┘               │
│                   │                               │
│  验证 ← 修改结果 ←┘                               │
│  bash 测试 / read_file 验证                        │
│  输出总结                                          │
└──────────────────────────────────────────────────┘
```

### 2.3 与四种 mode 的兼容

| mode | 主循环模型 | supervisorMode | 子智能体 | 行为 |
|------|-----------|:---:|:---:|------|
| `auto` + Pro | Pro | ✅ | ✅ | Pro 分析 + 委派 Flash 修改 |
| `pro` | Pro | ❌ | ❌ | Pro 全干（保持旧行为） |
| `flash` | Flash | ❌ | ❌ | Flash 全干（保持旧行为） |
| `auto` + Flash | Flash | ❌ | ❌ | Flash 全干（保持旧行为） |

---

## 三、代码变更

### 3.1 model-capabilities.ts：大幅简化

**移除**：
- `SwitchContext` 类型及其所有滞回控制字段（`roundsOnFlash`/`roundsOnPro`/`errorRate`…）
- `decideProToFlash()` 函数（成本回本计算）
- `decideFlashToPro()` 函数（复杂度评分）
- `expectedInputPrice()` 辅助函数
- `selectModelForIteration()` 函数（已废弃）
- 所有滞回控制常量（`MIN_PRO_DWELL`/`MIN_FLASH_DWELL`/`PRO_UPGRADE_COMPLEXITY_THRESHOLD`）

**简化为**：
```typescript
export function selectModelByPrice(
  primaryModel: string,
  _hadToolCalls: boolean,
  _ctx: Record<string, unknown>,
): { model: string; reason: string; paybackRounds: number } {
  return {
    model: primaryModel,
    reason: "Supervisor-Worker 架构 —— 主循环固定 Pro，修改委派子智能体",
    paybackRounds: NaN,
  };
}
```

净删除约 210 行。

### 3.2 session.ts：移除主循环切换

**移除**（约 200 行）：
- `wasAutoSwitched` 标记
- `roundsOnFlash`/`roundsOnPro`/`newUserMessage`/`uniqueTools`/`toolErrors`/`toolTotal` 状态追踪
- `proPricing`/`flashPricing`/`autoSwitch` 预获取
- `accumulatedTokens` 计算
- `selectModelByPrice()` 调用 + `SwitchContext` 构造
- `selectModelForIteration()` 回退分支
- `selectedModel !== currentModel` 切换分支
- P2 质量预检（Flash 空响应回退 Pro）
- 双向切换状态更新（`roundsOnFlash++`/`roundsOnPro++`）

**保留**：
- `currentClient`/`currentModel`/`currentThinkingEnabled` 从 `primary` 解析，整个循环不变
- 子智能体 usage 合并逻辑（`session.ts:2086-2108`）

### 3.3 prompt.ts：更新行为指南

`CODE_EXECUTOR_GUIDANCE` 从双向切换描述改为 Supervisor 模式：

```diff
- # Code modification strategy (Supervisor-Worker mode)
- When the spawn_code_executor tool is available to you:
+ You are the Supervisor. Your Pro context is always hot (cached).
+ Use spawn_code_executor to delegate code modifications to a Flash sub-agent:
  1. Read before you delegate.
  2. Judge complexity.
     ...
  5. Verify after delegation.
```

移除 `getFlashAutoSwitchMessage()` 函数（不再有主循环内的 Flash 切换消息）。

### 3.4 code-executor.ts：已有能力保留

| 功能 | 状态 |
|------|:--:|
| Flash 子智能体隔离循环（thinking=on, effort=high, maxIters=8） | ✅ |
| 工具范围限制（仅 read_file/edit_file/write_file） | ✅ |
| `CODE_EXECUTOR_SYSTEM` 自修正重试指令 | ✅ |
| edit 失败自动重试追踪（`editRetries` Map） | ✅ |
| 子智能体 usage 合并到 session.usageByModel | ✅ |
| 降级回退（Flash client 不可用时回退默认） | ✅ |
| 条件注册（仅 `supervisorMode=true` 时注册 spawn_code_executor） | ✅ |

### 3.5 文件统计

```
 src/model-capabilities.ts              | 264 →  54 (-210行)
 src/session.ts                         |      -200行
 src/prompt.ts                          |       +19行 (CODE_EXECUTOR_GUIDANCE relocated)
 src/tests/model-capabilities.test.ts   | 284 →  54 (-230行, 重写)
 src/tests/prompt.test.ts               |  44 →  36 (  -8行, 更新条件注册测试)
 ───────────────────────────────────────
 5 files changed, +210 -754 (-544 net)
```

---

## 四、效果预估

| 指标 | 旧方案（主循环切换） | 新方案（子智能体委派） |
|------|:--:|:--:|
| 200K上下文×100次请求成本 | ¥10.45 | **¥4.40** |
| Pro prefix-cache 命中率 | 0.50 | **0.95** |
| 修改执行成本 | ¥2.0/M（Flash主循环） | **¥2.0/M**（子智能体，相同） |
| 单次子智能体冷启动 | — | **¥0.01**（10K tokens） |
| 震荡风险 | 高（ping-pong） | **无**（单向委派） |
| Pro 分析深度 | 1轮被截断 | **完整多轮** |

---

## 五、对照 Reasonix 与 DeepSeek-TUI

| 维度 | Reasonix | DeepSeek-TUI | 本项目（新方案） |
|------|----------|-------------|----------------|
| 主循环模型 | Flash（auto模式） | 用户配置 | **Pro（固定）** |
| 升级方向 | Flash→Pro（`<<<NEEDS_PRO>>>` 标记或失败计数） | 无 | Flash→Pro（复杂度评分，仅子智能体内） |
| 降级方向 | 无 | 无 | **无**（Pro 不下放主循环） |
| 修改执行 | Flash 子智能体（隔离） | 主循环直接改 | **Flash 子智能体（隔离）** |
| 缓存策略 | Flash 热 ~96% | 依赖稳定路由 | **Pro 热 ~95%** |
| 核心理念 | 默认快、按需升级 | 用户手动控制 | **默认精、快在子智能体** |

---

## 六、后续方向

1. **并行子智能体**：Pro 同时委派多个 Flash 改不同文件
2. **子智能体内部验证**：修改后运行 linter/typecheck，失败时自动修正
3. **委派频率保护**：单 session >10 次委派时提示警告
4. **前缀预热**：idle 时后台预热子智能体的 Flash cache
5. **分层响应模式**：Flash 出草稿 → Pro 改进（而非 Pro 从零生成）
