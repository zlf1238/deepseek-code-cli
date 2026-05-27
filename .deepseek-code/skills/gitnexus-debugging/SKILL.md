---
name: gitnexus-debugging
description: "当用户调试 bug、追踪错误或询问为什么某功能失败时使用。示例：\"为什么 X 失败了？\"、\"这个错误从哪来？\"、\"追踪这个 bug\""
---

# 使用 GitNexus 调试

## 何时使用

- "为什么这个函数失败了？"
- "追踪这个错误从哪来"
- "谁调用了这个方法？"
- "这个接口返回 500"
- 调查 bug、错误或意外行为

## 工作流

```
1. gitnexus_query({query: "<错误或症状>"})         → 查找相关的执行流
2. gitnexus_context({name: "<可疑符号>"})           → 查看调用者/被调用者/进程
3. READ gitnexus://repo/{name}/process/{name}       → 追踪执行流
4. gitnexus_cypher({query: "MATCH path..."})        → 需要时自定义追踪
```

> 如果提示"Index is stale"→ 在终端运行 `npx gitnexus analyze`。

## 检查清单

```
- [ ] 理解症状（错误消息、意外行为）
- [ ] 对错误文本或相关代码执行 gitnexus_query
- [ ] 从返回的进程中识别可疑函数
- [ ] gitnexus_context 查看调用者和被调用者
- [ ] 通过进程资源追踪执行流（如适用）
- [ ] 需要时用 gitnexus_cypher 进行自定义调用链追踪
- [ ] 读取源文件确认根因
```

## 调试模式

| 症状              | GitNexus 方法                                                    |
| ----------------- | ---------------------------------------------------------------- |
| 错误消息          | `gitnexus_query` 搜索错误文本 → `context` 查看抛出位置            |
| 返回值错误        | `context` 查看函数 → 追踪被调用者分析数据流                       |
| 间歇性失败        | `context` → 查找外部调用、异步依赖                                |
| 性能问题          | `context` → 查找调用者多的符号（热点路径）                        |
| 最近的回归        | `detect_changes` 查看你的变更影响了什么                           |

## 工具

**gitnexus_query** — 查找与错误相关的代码：

```
gitnexus_query({query: "支付验证错误"})
→ 进程：CheckoutFlow, ErrorHandling
→ 符号：validatePayment, handlePaymentError, PaymentException
```

**gitnexus_context** — 可疑符号的完整上下文：

```
gitnexus_context({name: "validatePayment"})
→ 入向调用：processCheckout, webhookHandler
→ 出向调用：verifyCard, fetchRates (外部 API！)
→ 进程：CheckoutFlow (步骤 3/7)
```

**gitnexus_cypher** — 自定义调用链追踪：

```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## 示例："支付接口间歇性返回 500"

```
1. gitnexus_query({query: "支付错误处理"})
   → 进程: CheckoutFlow, ErrorHandling
   → 符号: validatePayment, handlePaymentError

2. gitnexus_context({name: "validatePayment"})
   → 出向调用: verifyCard, fetchRates (外部 API！)

3. READ gitnexus://repo/my-app/process/CheckoutFlow
   → 步骤 3: validatePayment → 调用 fetchRates (外部)

4. 根因: fetchRates 调用外部 API 时缺少适当的超时处理
```
