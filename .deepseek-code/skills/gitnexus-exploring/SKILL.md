---
name: gitnexus-exploring
description: "当用户询问代码如何工作、想要理解架构、追踪执行流或探索不熟悉的代码库部分时使用。示例：\"X 是怎么工作的？\"、\"谁调用了这个函数？\"、\"展示认证流程\""
---

# 使用 GitNexus 探索代码库

## 何时使用

- "认证是怎么工作的？"
- "项目结构是什么样的？"
- "展示主要组件"
- "数据库逻辑在哪？"
- 理解你之前没见过的代码

## 工作流

```
1. READ gitnexus://repos                           → 发现已索引的仓库
2. READ gitnexus://repo/{name}/context             → 代码库概览，检查新鲜度
3. gitnexus_query({query: "<你想理解的内容>"})     → 查找相关的执行流
4. gitnexus_context({name: "<符号名>"})             → 深入查看特定符号
5. READ gitnexus://repo/{name}/process/{name}       → 追踪完整执行流
```

> 如果步骤 2 提示"Index is stale"→ 在终端运行 `npx gitnexus analyze`。

## 检查清单

```
- [ ] READ gitnexus://repo/{name}/context
- [ ] 对你想要理解的概念执行 gitnexus_query
- [ ] 审查返回的进程（执行流）
- [ ] gitnexus_context 查看关键符号的调用者/被调用者
- [ ] READ 进程资源查看完整执行追踪
- [ ] 读取源文件了解实现细节
```

## 资源

| 资源                                       | 获得的内容                                       |
| ------------------------------------------ | ------------------------------------------------ |
| `gitnexus://repo/{name}/context`           | 统计信息、新鲜度警告（~150 tokens）               |
| `gitnexus://repo/{name}/clusters`          | 所有功能区域及内聚度评分（~300 tokens）           |
| `gitnexus://repo/{name}/cluster/{name}`    | 区域成员及文件路径（~500 tokens）                 |
| `gitnexus://repo/{name}/process/{name}`    | 分步骤执行追踪（~200 tokens）                     |

## 工具

**gitnexus_query** — 查找与某个概念相关的执行流：

```
gitnexus_query({query: "支付处理"})
→ 进程：CheckoutFlow, RefundFlow, WebhookHandler
→ 按流程分组的符号及文件位置
```

**gitnexus_context** — 符号的 360 度视图：

```
gitnexus_context({name: "validateUser"})
→ 入向调用：loginHandler, apiMiddleware
→ 出向调用：checkToken, getUserById
→ 进程：LoginFlow (步骤 2/5), TokenRefresh (步骤 1/3)
```

## 示例："支付处理是怎么工作的？"

```
1. READ gitnexus://repo/my-app/context       → 918 个符号, 45 个进程
2. gitnexus_query({query: "支付处理"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. gitnexus_context({name: "processPayment"})
   → 入向：checkoutHandler, webhookHandler
   → 出向：validateCard, chargeStripe, saveTransaction
4. 读取 src/payments/processor.ts 了解实现细节
```
