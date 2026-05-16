# 逻辑漏洞报告

> 提交：`d105c133` — `feat: 实现价格感知的模型自动切换功能`
> 日期：2026-05-10
> 作者：zlf123

---

## 漏洞 1：`extractLastToolName` 永远返回 `undefined`（严重）

**文件**：`src/session.ts` 第 228–240 行

**问题描述**：

`extractLastToolName` 使用 `isUsageRecord` 来判断工具调用对象，但该函数的判断逻辑与工具调用的实际结构不匹配，导致永远无法正确提取工具名称。

`isUsageRecord` 的定义：

```typescript
function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

工具调用的实际结构：

```typescript
{ id: "...", type: "function", function: { name: "...", arguments: "..." } }
```

工具调用对象虽然不是 `null`、是对象、不是数组，但由于包含 `id`、`type` 等属性，不属于"usage 记录"，因此 `isUsageRecord(last)` 条件本身就会返回 `false`，导致函数直接跳到 `return undefined`。

**根本原因**：`isUsageRecord` 本是用于区分"usage 统计对象"（如 `{ total_tokens: N }`）和"普通对象"的辅助函数，被错误地复用于工具调用类型判断。

**影响**：`lastToolName` 永远是 `undefined`，`selectModelByPrice` 中 P3 的 `AskUserQuestion` 锁定保护**完全失效**。用户在等待 AI 向其提问确认时，模型可能被降级到 Flash，导致交互质量下降。

**修复建议**：

将 `extractLastToolName` 改为直接检查属性存在性：

```typescript
private extractLastToolName(toolCalls: unknown[]): string | undefined {
  if (toolCalls.length === 0) return undefined;
  const last = toolCalls[toolCalls.length - 1];
  if (
    typeof last === "object" &&
    last !== null &&
    !Array.isArray(last)
  ) {
    const fn = (last as Record<string, unknown>).function;
    if (
      typeof fn === "object" &&
      fn !== null &&
      !Array.isArray(fn)
    ) {
      const name = (fn as Record<string, unknown>).name;
      return typeof name === "string" ? name : undefined;
    }
  }
  return undefined;
}
```

---

## 漏洞 2：测试注释与测试名称不一致（中等）

**文件**：`src/tests/model-capabilities.test.ts` 第 643–652 行

**问题描述**：

测试名称为 `"2.5x discount: Pro cheaper in hit+output, Flash cheaper in miss -> switches Flash when payback <= 8"`，暗示在该定价条件下应该切换到 Flash。但实际定价是：

| 维度 | Pro | Flash |
|------|-----|-------|
| Cache Hit | $0.025 | $0.01 |
| Cache Miss | $0.25 | $1.00 |
| Output | $0.075 | $0.40 |

Flash 仅在 Cache Hit 上更便宜，其余两个维度 Pro 更便宜或持平，因此根据 `selectModelByPrice` 的逻辑，**应该留在 Pro**。断言 `assert.equal(result.model, DEEPSEEK_V4_PRO)` 本身是对的，但：

- 测试名称中的 "Flash cheaper in miss" 描述错误
- 注释中详细解释了为什么不切换，但整体注释结构混乱（先写了"switch to Flash"，又被划掉改成了"stay on Pro"）

**影响**：误导后续阅读代码的开发者，误以为存在"应该切换 Flash 但实际留在 Pro"的边界场景。

**修复建议**：重写测试名称和注释，使其准确反映测试意图，例如：

```typescript
test("2.5x discount: Flash only cheaper in cacheHit -> stay on Pro", () => {
  // ...
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("Flash output not cheaper") || result.reason.includes("cheaper in all"));
});
```

---

## 漏洞 3：`accumulatedTokens` 在切换轮次计算偏低（中等）

**文件**：`src/session.ts` 第 920–921 行

**问题描述**：

```typescript
const sessionEntry = this.getSession(sessionId);
const accumulatedTokens = sessionEntry ? getTotalTokens(sessionEntry.usage) : 0;
```

当 Pro → Flash 切换发生时，`accumulatedTokens` 取自 `sessionEntry.usage`（历史累积量），**不包含当前轮次正在生成的 Flash input tokens**（包含 Pro 已生成的 output 作为 context）。

**影响**：

- `switchPenalty` = `accumulatedTokens/1M * (flash.cacheMiss - pro.cacheHit)` 被低估
- 低估的 penalty → 更低的 `paybackRounds` → 更容易满足切换条件
- 结果：**Flash 可能过早被启用**，增加输出成本（与"价格感知"的优化目标相悖）

**修复建议**：在模型选择时，将当前轮次已处理的 input tokens 也纳入计算，或者在切换标记时记录"切换发生时的上下文 token 数"作为基准。

---

## 漏洞 4：`maxPaybackRounds = 0` 语义不清（轻微）

**文件**：`src/settings.ts` 第 547–548 行

**问题描述**：

```typescript
const maxPaybackRounds = (typeof raw?.maxPaybackRounds === "number" && raw.maxPaybackRounds > 0)
  ? raw.maxPaybackRounds : 8;
```

用户配置 `maxPaybackRounds: 0` 会被静默替换为 `8`。`0` 可能被理解为"禁止一切切换"（禁用自动切换），但实际行为等同于"允许最多 8 轮回本"。

**影响**：配置项语义不直观，用户无法通过设置 `maxPaybackRounds` 来"完全禁用"价格感知切换。

**修复建议**：增加 `enabled?: boolean` 配置字段来控制开关，将 `maxPaybackRounds` 的语义纯粹用于调节"保守/激进"程度。

---

## 漏洞 5：`wasAutoSwitched` 重置后永久锁定 Pro（需评估）

**文件**：`src/session.ts` 第 1042 行

**问题描述**：

P2 回退逻辑中 `wasAutoSwitched` 被重置为 `false`，加上 bug 1 导致 `lastToolName` 永远为 `undefined`。对于需要多次"Pro 分析 → Flash 执行 → Pro 分析"循环的任务（如大型重构），系统会在第一次回退后永久停留在 Pro，失去价格感知切换的价值。

**评估**：如果这是预期行为（保证质量优先），则不是 bug，但应在文档或注释中明确说明。

---

## 优先级总结

| 编号 | 漏洞 | 严重程度 | 优先级 |
|------|------|---------|--------|
| 1 | `extractLastToolName` 永远返回 `undefined` | 🔴 严重 | P0 |
| 2 | 测试注释与名称不一致 | 🟡 中等 | P2 |
| 3 | `accumulatedTokens` 切换轮次计算偏低 | 🟡 中等 | P2 |
| 4 | `maxPaybackRounds=0` 语义不清 | 🟢 轻微 | P3 |
| 5 | `wasAutoSwitched` 重置后永久锁定 Pro | 需评估 | P3 |
