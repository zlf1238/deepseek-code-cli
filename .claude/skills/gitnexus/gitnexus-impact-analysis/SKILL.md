---
name: gitnexus-impact-analysis
description: "当用户想知道修改某个内容会破坏什么，或需要在编辑代码前进行安全分析时使用。示例：\"修改 X 安全吗？\"、\"什么依赖了这个？\"、\"会破坏什么？\""
---

# 使用 GitNexus 进行影响分析

## 何时使用

- "修改这个函数安全吗？"
- "如果我修改 X，会破坏什么？"
- "显示影响范围"
- "谁使用了这段代码？"
- 在进行非平凡的代码变更之前
- 在提交之前——了解你的变更影响了什么

## 工作流

```
1. gitnexus_impact({target: "X", direction: "upstream"})  → 什么依赖了这个
2. READ gitnexus://repo/{name}/processes                   → 检查受影响的执行流
3. gitnexus_detect_changes()                               → 将当前 git 变更映射到受影响的流程
4. 评估风险并向用户报告
```

> 如果提示"索引过期" → 在终端中运行 `npx gitnexus analyze`。

## 检查清单

```
- [ ] gitnexus_impact({target, direction: "upstream"}) 查找依赖项
- [ ] 首先审查 d=1 的项目（这些会直接破坏）
- [ ] 检查高置信度（>0.8）的依赖
- [ ] 读取进程资源检查受影响的执行流
- [ ] 提交前执行 gitnexus_detect_changes()
- [ ] 评估风险等级并向用户报告
```

## 理解输出

| 深度  | 风险等级           | 含义                       |
| ----- | ------------------ | -------------------------- |
| d=1   | **会直接破坏**      | 直接调用者/导入者           |
| d=2   | **可能受影响**      | 间接依赖                   |
| d=3   | **可能需要测试**    | 传递性影响                 |

## 风险评估

| 受影响范围                        | 风险     |
| --------------------------------- | -------- |
| <5 个符号，少数进程               | 低       |
| 5-15 个符号，2-5 个进程           | 中       |
| >15 个符号或多个进程              | 高       |
| 关键路径（认证、支付）            | 严重     |

## 工具

**gitnexus_impact** — 符号影响范围的主要工具：

```
gitnexus_impact({
  target: "validateUser",
  direction: "upstream",
  minConfidence: 0.8,
  maxDepth: 3
})

→ d=1（会直接破坏）:
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2（可能受影响）:
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**gitnexus_detect_changes** — 基于 git-diff 的影响分析：

```
gitnexus_detect_changes({scope: "staged"})

→ 变更：3 个文件中的 5 个符号
→ 受影响：LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ 风险：中
```

## 示例："如果我修改 validateUser，会破坏什么？"

```
1. gitnexus_impact({target: "validateUser", direction: "upstream"})
   → d=1: loginHandler, apiMiddleware（会直接破坏）
   → d=2: authRouter, sessionManager（可能受影响）

2. READ gitnexus://repo/my-app/processes
   → LoginFlow 和 TokenRefresh 涉及了 validateUser

3. 风险：2 个直接调用者，2 个进程 = 中
```
