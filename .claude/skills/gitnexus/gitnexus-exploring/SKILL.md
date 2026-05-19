---
name: gitnexus-exploring
description: "当用户询问代码如何工作、想了解架构、追踪执行流或探索代码库中不熟悉的部分时使用。示例：\"X 是如何工作的？\"、\"谁调用了这个函数？\"、\"显示认证流程\""
---

# 使用 GitNexus 探索代码库

## 何时使用

- "认证是如何工作的？"
- "项目结构是什么样的？"
- "显示主要组件"
- "数据库逻辑在哪里？"
- 理解你从未见过的代码

## 工作流

```
1. READ gitnexus://repos                          → 发现已索引的仓库
2. READ gitnexus://repo/{name}/context             → 代码库概览，检查是否过期
3. gitnexus_query({query: "<你想了解的内容>"})      → 查找相关的执行流
4. gitnexus_context({name: "<符号名称>"})           → 深入特定符号
5. READ gitnexus://repo/{name}/process/{name}      → 追踪完整的执行流
```

> 如果步骤 2 提示"索引过期" → 在终端中运行 `npx gitnexus analyze`。

## 检查清单

```
- [ ] READ gitnexus://repo/{name}/context
- [ ] 对你想了解的概念执行 gitnexus_query
- [ ] 审查返回的进程（执行流）
- [ ] 对关键符号使用 gitnexus_context 查看调用者/被调用者
- [ ] 读取进程资源获取完整执行追踪
- [ ] 阅读源文件了解实现细节
```

## 资源

| 资源                                      | 获取内容                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| `gitnexus://repo/{name}/context`          | 统计数据、过期警告（约 150 tokens）                         |
| `gitnexus://repo/{name}/clusters`         | 所有功能领域及其内聚度评分（约 300 tokens）                  |
| `gitnexus://repo/{name}/cluster/{name}`   | 领域成员及其文件路径（约 500 tokens）                        |
| `gitnexus://repo/{name}/process/{name}`   | 分步骤执行追踪（约 200 tokens）                             |

## 工具

**gitnexus_query** — 查找与某个概念相关的执行流：

```
gitnexus_query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**gitnexus_context** — 符号的 360 度视图：

```
gitnexus_context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## 示例："支付处理是如何工作的？"

```
1. READ gitnexus://repo/my-app/context       → 918 个符号, 45 个进程
2. gitnexus_query({query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. gitnexus_context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. 阅读 src/payments/processor.ts 获取实现细节
```
