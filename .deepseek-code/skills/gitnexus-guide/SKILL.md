---
name: gitnexus-guide
description: "当用户询问 GitNexus 本身时使用——可用的工具、如何查询知识图谱、MCP 资源、图谱 schema 或工作流参考。示例：\"有哪些 GitNexus 工具可用？\"、\"如何使用 GitNexus？\""
---

# GitNexus 指南

所有 GitNexus MCP 工具、资源和知识图谱 schema 的快速参考。

## 始终从这里开始

对于任何涉及代码理解、调试、影响分析或重构的任务：

1. **读取 `gitnexus://repo/{name}/context`** — 代码库概览 + 检查索引新鲜度
2. **将你的任务匹配到下面的技能** 并 **阅读该技能文件**
3. **遵循该技能的工作流和检查清单**

> 如果步骤 1 警告索引过期，先在终端运行 `npx gitnexus analyze`。

## 技能

| 任务                                         | 要读取的技能             |
| -------------------------------------------- | ----------------------- |
| 理解架构 / "X 是怎么工作的？"                | `gitnexus-exploring`         |
| 影响面 / "改了 X 会坏什么？"                 | `gitnexus-impact-analysis`   |
| 追踪 bug / "为什么 X 失败？"                 | `gitnexus-debugging`         |
| 重命名 / 提取 / 拆分 / 重构                  | `gitnexus-refactoring`       |
| 工具、资源、schema 参考                      | `gitnexus-guide`（本文件）   |
| 索引、状态、清理、wiki CLI 命令              | `gitnexus-cli`               |

## 工具参考

| 工具             | 提供的功能                                                         |
| ---------------- | ----------------------------------------------------------------- |
| `query`          | 按进程分组的代码智能——与某个概念相关的执行流                       |
| `context`        | 符号的 360 度视图——分类引用、参与的进程                           |
| `impact`         | 符号影响面——深度 1/2/3 各会坏什么，附带置信度                     |
| `detect_changes` | Git diff 影响——当前变更会影响什么                                 |
| `rename`         | 多文件协调重命名，附带置信度标记的编辑                              |
| `cypher`         | 原始图查询（先读取 `gitnexus://repo/{name}/schema`）               |
| `list_repos`     | 发现已索引的仓库                                                   |

## 资源参考

轻量级读取（~100-500 tokens），用于导航：

| 资源                                              | 内容                         |
| ------------------------------------------------- | ---------------------------- |
| `gitnexus://repo/{name}/context`                  | 统计信息、新鲜度检查           |
| `gitnexus://repo/{name}/clusters`                 | 所有功能区域及内聚度评分       |
| `gitnexus://repo/{name}/cluster/{clusterName}`    | 区域成员                     |
| `gitnexus://repo/{name}/processes`                | 所有执行流                   |
| `gitnexus://repo/{name}/process/{processName}`    | 分步骤追踪                   |
| `gitnexus://repo/{name}/schema`                   | 用于 Cypher 查询的图谱 schema |

## 图谱 Schema

**节点：** File, Function, Class, Interface, Method, Community, Process
**边（通过 CodeRelation.type）：** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```
