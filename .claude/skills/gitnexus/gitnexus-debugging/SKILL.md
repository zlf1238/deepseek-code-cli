---
name: gitnexus-debugging
description: "当用户在调试 Bug、追踪错误或询问某事物为什么会失败时使用。示例：\"为什么 X 失败了？\"、\"这个错误从哪里来？\"、\"追踪这个 Bug\""
---

# 使用 GitNexus 调试

## 何时使用

- "为什么这个函数失败了？"
- "追踪这个错误的来源"
- "谁调用了这个方法？"
- "这个接口返回 500"
- 调查 Bug、错误或意外行为

## 工作流

```
1. gitnexus_query({query: "<错误或症状>"})            → 查找相关的执行流
2. gitnexus_context({name: "<可疑符号>"})              → 查看调用者/被调用者/进程
3. READ gitnexus://repo/{name}/process/{name}          → 追踪执行流
4. gitnexus_cypher({query: "MATCH path..."})            → 如果需要，执行自定义追踪
```

> 如果提示"索引过期" → 在终端中运行 `npx gitnexus analyze`。

## 检查清单

```
- [ ] 理解症状（错误消息、意外行为）
- [ ] 对错误文本或相关代码执行 gitnexus_query
- [ ] 从返回的进程中识别可疑函数
- [ ] 使用 gitnexus_context 查看调用者和被调用者
- [ ] 如适用，通过进程资源追踪执行流
- [ ] 如果需要，使用 gitnexus_cypher 进行自定义调用链追踪
- [ ] 阅读源文件确认根因
```

## 调试模式

| 症状                | GitNexus 方法                                                      |
| ------------------- | ------------------------------------------------------------------ |
| 错误消息             | 对错误文本执行 `gitnexus_query` → 在抛出位置执行 `context`           |
| 返回值错误           | 对函数执行 `context` → 追踪被调用者以查找数据流                       |
| 间歇性失败           | `context` → 查找外部调用、异步依赖                                    |
| 性能问题             | `context` → 查找有很多调用者的符号（热点路径）                         |
| 最近的回归           | 使用 `detect_changes` 查看你的变更影响了什么                          |

## 工具

**gitnexus_query** — 查找与错误相关的代码：

```
gitnexus_query({query: "payment validation error"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**gitnexus_context** — 可疑符号的完整上下文：

```
gitnexus_context({name: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (外部 API!)
→ Processes: CheckoutFlow (step 3/7)
```

**gitnexus_cypher** — 自定义调用链追踪：

```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## 示例："支付接口间歇性返回 500"

```
1. gitnexus_query({query: "payment error handling"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. gitnexus_context({name: "validatePayment"})
   → Outgoing calls: verifyCard, fetchRates (外部 API!)

3. READ gitnexus://repo/my-app/process/CheckoutFlow
   → Step 3: validatePayment → 调用 fetchRates (外部)

4. 根因：fetchRates 调用外部 API 时没有设置合适的超时
```
