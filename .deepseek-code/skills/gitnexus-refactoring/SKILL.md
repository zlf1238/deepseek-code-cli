---
name: gitnexus-refactoring
description: "当用户想要安全地重命名、提取、拆分、移动或重构代码时使用。示例：\"重命名这个函数\"、\"提取到模块\"、\"重构这个类\"、\"移动到单独文件\""
---

# 使用 GitNexus 重构

## 何时使用

- "安全地重命名这个函数"
- "提取到模块"
- "拆分这个服务"
- "移动到新文件"
- 任何涉及重命名、提取、拆分或重构代码的任务

## 工作流

```
1. gitnexus_impact({target: "X", direction: "upstream"})  → 映射所有依赖者
2. gitnexus_query({query: "X"})                            → 查找涉及 X 的执行流
3. gitnexus_context({name: "X"})                           → 查看所有入向/出向引用
4. 规划更新顺序：接口 → 实现 → 调用者 → 测试
```

> 如果提示"Index is stale"→ 在终端运行 `npx gitnexus analyze`。

## 检查清单

### 重命名符号

```
- [ ] gitnexus_rename({symbol_name: "oldName", new_name: "newName", dry_run: true}) — 预览所有编辑
- [ ] 审查图谱编辑（高置信度）和 ast_search 编辑（仔细审查）
- [ ] 如果满意：gitnexus_rename({..., dry_run: false}) — 应用编辑
- [ ] gitnexus_detect_changes() — 验证只修改了预期文件
- [ ] 运行受影响进程的测试
```

### 提取模块

```
- [ ] gitnexus_context({name: target}) — 查看所有入向/出向引用
- [ ] gitnexus_impact({target, direction: "upstream"}) — 查找所有外部调用者
- [ ] 定义新模块接口
- [ ] 提取代码，更新导入
- [ ] gitnexus_detect_changes() — 验证受影响范围
- [ ] 运行受影响进程的测试
```

### 拆分函数/服务

```
- [ ] gitnexus_context({name: target}) — 理解所有被调用者
- [ ] 按职责分组被调用者
- [ ] gitnexus_impact({target, direction: "upstream"}) — 映射需要更新的调用者
- [ ] 创建新函数/服务
- [ ] 更新调用者
- [ ] gitnexus_detect_changes() — 验证受影响范围
- [ ] 运行受影响进程的测试
```

## 工具

**gitnexus_rename** — 自动化的多文件重命名：

```
gitnexus_rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
→ 8 个文件中的 12 处编辑
→ 10 个图谱编辑（高置信度），2 个 ast_search 编辑（需审查）
→ 变更: [{file_path, edits: [{line, old_text, new_text, confidence}]}]
```

**gitnexus_impact** — 先映射所有依赖者：

```
gitnexus_impact({target: "validateUser", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ 受影响进程: LoginFlow, TokenRefresh
```

**gitnexus_detect_changes** — 重构后验证变更：

```
gitnexus_detect_changes({scope: "all"})
→ 变更: 8 个文件, 12 个符号
→ 受影响进程: LoginFlow, TokenRefresh
→ 风险: 中
```

**gitnexus_cypher** — 自定义引用查询：

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath ORDER BY caller.filePath
```

## 风险规则

| 风险因素           | 缓解措施                                     |
| ----------------- | ------------------------------------------- |
| 调用者多（>5 个） | 使用 gitnexus_rename 进行自动化更新           |
| 跨区域引用        | 之后使用 detect_changes 验证范围              |
| 字符串/动态引用   | 使用 gitnexus_query 查找它们                 |
| 外部/公共 API    | 做好版本控制和弃用处理                        |

## 示例：将 `validateUser` 重命名为 `authenticateUser`

```
1. gitnexus_rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: true})
   → 12 处编辑: 10 个图谱（安全）, 2 个 ast_search（需审查）
   → 文件: validator.ts, login.ts, middleware.ts, config.json...

2. 审查 ast_search 编辑（config.json: 动态引用！）

3. gitnexus_rename({symbol_name: "validateUser", new_name: "authenticateUser", dry_run: false})
   → 已应用 8 个文件中的 12 处编辑

4. gitnexus_detect_changes({scope: "all"})
   → 受影响: LoginFlow, TokenRefresh
   → 风险: 中 — 为这些流程运行测试
```
