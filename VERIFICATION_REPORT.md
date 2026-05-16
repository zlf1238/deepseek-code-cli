# 逻辑漏洞验证报告

> 验证日期：2026-05-10
> 验证对象：`LOGIC_BUGS_REPORT.md`（提交 `d105c133` — `feat: 实现价格感知的模型自动切换功能`）

---

## 漏洞 1：`extractLastToolName` 永远返回 `undefined` — ❌ **结论错误**

**文件**：`src/session.ts` 第 228–240 行

### 报告描述的问题

报告声称 `isUsageRecord(last)` 对工具调用对象会返回 `false`，因为工具调用包含 `id`、`type` 等属性，不属于"usage 记录"，导致 `extractLastToolName` 永远走不到提取逻辑，直接返回 `undefined`。

### 代码验证

`isUsageRecord` 的定义：

```21:22:src/session.ts
function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

一个标准工具调用对象 `{ id: "...", type: "function", function: { name: "AskUserQuestion", arguments: "..." } }`：
- 不是 `null` → ✓
- `typeof` 是 `"object"` → ✓
- 不是数组 → ✓

所以 **`isUsageRecord(last)` 会返回 `true`**，接着 `isUsageRecord(fn)` 也返回 `true`（`function` 字段同样是普通对象），最终 `name` 被正确提取。

### 结论

报告的结论（永远返回 `undefined`）是**错误的**——代码逻辑上能正常工作，`lastToolName` 并非永远是 `undefined`。

### 真正的问题

`isUsageRecord` 这个函数名是为"usage 统计对象"（如 `{ total_tokens: N }`）设计的类型守卫，但在 `extractLastToolName` 中被错误地复用来判断"这是工具调用"。代码碰巧能工作，但意图上完全误导——应该直接检查 `function` 属性是否存在，而不是用一个语义不相关的谓词函数。

### 建议

重构 `extractLastToolName`，直接检查属性存在性，使代码意图清晰：

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

### 实测验证

测试文件直接测试了这个路径，确实能正确返回 `"AskUserQuestion"`：

```63:68:src/tests/model-capabilities.test.ts
test("AskUserQuestion locks Pro", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    lastToolName: "AskUserQuestion",
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("AskUserQuestion"));
});
```

---

## 漏洞 2：测试注释与名称不一致 — ✅ **已确认**

**文件**：`src/tests/model-capabilities.test.ts` 第 71–81 行

测试名称为 `"2.5x discount: Pro cheaper in hit+output, Flash cheaper in miss -> switches Flash when payback <= 8"`，暗示在该定价条件下应该切换到 Flash。但实际断言是 `assert.equal(result.model, DEEPSEEK_V4_PRO)`，即**应该留在 Pro**。

### 问题

- 测试名称中的 `"Flash cheaper in miss"` 描述错误（实际定价中 Flash 的 miss 价格是 $1.00，远高于 Pro 的 $0.25）
- 注释中详细解释了为什么不切换（`"Should stay on Pro because Flash output is NOT cheaper"`），与测试名称自相矛盾
- 测试逻辑和断言本身是对的，但命名完全误导后续阅读代码的开发者

### 建议

重写测试名称和注释，使其准确反映测试意图：

```typescript
test("2.5x discount: Flash only cheaper in cacheHit -> stay on Pro", () => {
  // ...
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("Flash output not cheaper") || result.reason.includes("cheaper in all"));
});
```

---

## 漏洞 3：`accumulatedTokens` 切换轮次计算偏低 — ✅ **已确认**

**文件**：`src/session.ts` 第 920–921 行

```920:921:src/session.ts
const sessionEntry = this.getSession(sessionId);
const accumulatedTokens = sessionEntry ? getTotalTokens(sessionEntry.usage) : 0;
```

### 问题

`sessionEntry.usage` 是在 API 调用完成后才更新的，而 `accumulatedTokens` 在当前轮次模型选择时（第 931 行传入 `SwitchContext`）就被读取。因此，**当前轮次正在处理的 input tokens（包含上一轮 Pro 生成的 output 作为 context）完全未被计入**。

### 影响

- `switchPenalty = accumulatedTokens/1M * (flash.cacheMiss - pro.cacheHit)` 被低估
- 低估的 penalty → 更低的 `paybackRounds` → 更容易满足切换条件
- 结果：**Flash 可能过早被启用**，增加输出成本（与"价格感知"的优化目标相悖）

### 建议

在模型选择时，将当前轮次已处理的 input tokens 也纳入计算，或者在切换标记时记录"切换发生时的上下文 token 数"作为基准。

---

## 漏洞 4：`maxPaybackRounds = 0` 语义不清 — ✅ **已确认**

**文件**：`src/session.ts` 第 129–130 行（实际在 `settings.ts` 第 547–548 行的配置解析中）

```typescript
const maxPaybackRounds = (typeof raw?.maxPaybackRounds === "number" && raw.maxPaybackRounds > 0)
  ? raw.maxPaybackRounds : 8;
```

### 问题

`0` 在 JavaScript 中是 falsy，`0 > 0` 为 `false`，所以用户设 `maxPaybackRounds: 0` 意图是"禁用切换"，但被静默转为 `8`。这导致：

- 用户无法通过 `maxPaybackRounds: 0` 来"完全禁用"价格感知切换
- `0` 可能被理解为"禁止一切切换"，但实际行为等同于"允许最多 8 轮回本"

### 建议

增加 `enabled?: boolean` 配置字段来控制开关，将 `maxPaybackRounds` 的语义纯粹用于调节"保守/激进"程度。

---

## 漏洞 5：`wasAutoSwitched` 重置后永久锁定 Pro — ⚠️ **需按场景评估**

**文件**：`src/session.ts` 第 1042 行

### 代码

```1042:src/session.ts
wasAutoSwitched = false;
```

### 分析

`lastToolName` 是从上一轮 tool calls 提取的（第 1062 行），在下一轮模型选择（第 931 行）时传入 `SwitchContext`。对于多轮"Pro 分析 → Flash 执行 → Pro 分析"循环：

- **Flash 执行成功**（无 P2 回退）：`wasAutoSwitched` 不会被重置，Flash 可以持续运行
- **Flash 执行失败**（P2 回退）：回退到 Pro 后 `wasAutoSwitched` 重置，下一轮仍有资格再次切换到 Flash

### 结论

如果这是预期行为（质量优先），则不是 bug。但建议在文档或注释中明确说明"回退后重置是为了保证质量"的策略意图。

**真正的问题**在于与漏洞 4 组合时：用户想通过 `maxPaybackRounds: 0` 禁用切换（但 bug 4 导致禁用无效），同时 bug 5 的重置行为可能让用户困惑"切换为什么没有按预期工作"。

---

## 优先级总结

| 编号 | 漏洞 | 验证结果 | 严重程度 | 优先级 |
|------|------|---------|---------|--------|
| 1 | `extractLastToolName` 永远返回 undefined | ❌ 结论错误（代码能工作，但语义错误） | ⚠️ 警告 | P1（需重构） |
| 2 | 测试注释与名称不一致 | ✅ 确认 | 🟡 中等 | P2 |
| 3 | `accumulatedTokens` 切换轮次计算偏低 | ✅ 确认 | 🟡 中等 | P2 |
| 4 | `maxPaybackRounds=0` 语义不清 | ✅ 确认 | 🟢 轻微 | P3 |
| 5 | `wasAutoSwitched` 重置后行为 | ⚠️ 需评估 | 🟢 轻微 | P3 |

---

## 验证结论

原始报告中仅 **漏洞 2、3、4** 被完全确认。漏洞 1 的报告描述了错误的前提（`isUsageRecord` 会返回 `false`），但确实存在一个真实的代码质量问题（用语义错误的函数名来判断工具调用类型）。漏洞 5 需要根据产品策略来决定是否为预期行为。
