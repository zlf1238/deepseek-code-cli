# deepseek-code-cli 优化会话总结

> 会话日期：2025年
> 参考项目：Reasonix (DeepSeek-Reasonix)
> 优化目标：提高 DeepSeek 缓存命中率、降低 token 成本、补齐工具缺口

---

## 一、会话脉络

```
缓存命中率分析 → Reasonix 机制研究 → 设计方案 → 逐项实施 → 工具/skill 补齐 → 修复管道 → 并行调度
```

共完成 **11 次提交**，修改/新增 **30+ 文件**，工具数从 9 → 20，skill 从 3 → 5。

---

## 二、Reasonix 缓存机制研究

### 2.1 DeepSeek 前缀缓存原理

- DeepSeek 采用**自动前缀匹配 KV Cache**
- 从第一个 token 开始比对，前缀匹配的 token 从硬盘缓存命中
- 缓存命中价：¥0.025/M (Pro) / ¥0.02/M (Flash) — 极便宜
- 缓存未命中价：¥3.0/M (Pro) / ¥1.0/M (Flash) — 贵 120 倍

### 2.2 Reasonix 五大核心机制

| # | 机制 | 位置 |
|---|------|------|
| 1 | **三区上下文分区** (ImmutablePrefix / AppendOnlyLog / VolatileScratch) | `memory/runtime.ts` |
| 2 | 所有动态内容**烘焙进 Prefix 字符串**（非独立消息） | `memory/user.ts:applyMemoryStack()` |
| 3 | Skills **仅索引进 prefix**，正文按需加载 | `skills.ts:applySkillsIndex()` |
| 4 | 模型切换**客户端变量切换**，不注入 API 消息 | `loop.ts:920-940` |
| 5 | Compaction **只动 Log 不动 Prefix**，摘要以 `assistant` 角色插入 | `context-manager.ts:fold()` |

---

## 三、已实施的优化清单

### 3.1 缓存命中率提升

| Commit | 改动 | 效果 |
|--------|------|------|
| `6758c3d` | **skill 索引化按需加载** — 正文不强制注入，改为 `SkillLoad` 工具按需获取 | prefix 体积从 ~12,500 tokens → ~300 tokens |
| `cea7818` | **AGENTS.md 烘焙进 system prompt** — 消除 M2 独立消息，拼入前缀字符串 | 消息序列从 `[sys][AGENTS][user]` → `[sys+AGENTS][user]` |
| `cea7818` | **模型切换消息移除** — 切换不再 `appendSessionMessage`，仅 `onAssistantMessage` 通知 UI | Pro↔Flash 切换对 API 透明，不截断缓存前缀 |

优化后的消息序列：
```
优化前: [sys][AGENTS.md][skill body][切换消息][user]  ← 4个断裂点
优化后: [sys+tools+runtime+skills索引+AGENTS.md][user] ← 0个断裂点
```

### 3.2 Token 成本降低

| Commit | 改动 | 效果 |
|--------|------|------|
| `8370147` | **compaction 硬编码 Flash** — `compactSession()` 使用 `v4-flash + effort=high` | 单次 compaction ¥0.088 → ¥0.015 (↓83%) |
| `9f6eb58` | **工具结果轮末截断** — `buildToolMessage()` 中 head+tail 各保留 3000 字符 | 多轮会话历史膨胀降低 60-80% |
| `dbb7bed` | **compaction 角色修正** — 摘要 `role: "system"` → `"assistant"` | 语义准确，避免被 LLM 误认为系统指令 |

### 3.3 工具补齐

| Commit | 新增工具 | 功能 |
|--------|------|------|
| `b3e21c6` | `directory_tree` | 树形目录浏览 |
| | `ask_choice` | 多选弹窗选择器 |
| | `multi_edit` | 批量多文件编辑 |
| | `todo_write` | 会话内任务追踪 |
| | `web_fetch` | HTTP 抓取 URL |
| | `run_background` | 后台命令执行 |
| | `job_output` | 查询后台任务 |
| | `list_jobs` | 后台任务列表 |
| `b29a3c9` | `search_files` | 文件名搜索 |
| | `get_file_info` | 文件元信息 |
| | `stop_job` | 停止后台任务 |

### 3.4 Skill 补齐

| Commit | 新增 Skill | 模式 |
|--------|------|------|
| `b29a3c9` | `test` | inline — 运行测试→诊断→修复→重跑 |
| | `review` | inline — git diff 审查 |

### 3.5 修复管道 (Pillar-2)

| Pass | 文件 | 功能 |
|------|------|------|
| **truncation** | `src/repair/truncation.ts` | 修复因 max_tokens 截断的不完整 JSON（补全括号、闭合字符串） |
| **scavenge** | `src/repair/scavenge.ts` | 从 reasoning_content 捞取遗漏的 tool call（3 种 JSON 模式） |
| **storm** | `src/repair/storm.ts` | 滑动窗口内同一 (tool, args) 重复 3 次即抑制 |

### 3.6 并行调度

| Commit | 改动 | 效果 |
|--------|------|------|
| `270e0d2` | `executeToolCalls()` 分组并行 | 只读工具(11个)通过 `Promise.allSettled` 竞争执行；写入工具串行屏障 |

### 3.7 上下文预检

| Commit | 改动 | 效果 |
|--------|------|------|
| `ad2c5db` | `estimateMessagesTokens()` + 发送前预检 | 超 95% 窗口时触发紧急压缩，避免发送必然 400 的超限请求 |

---

## 四、最终项目状态

### 4.1 工具列表 (20 个)

```
文件读取: read, glob, grep, directory_tree, search_files, get_file_info
文件写入: write, edit, multi_edit
Shell:    bash, run_background, job_output, list_jobs, stop_job
Web:      WebSearch, web_fetch
交互:     AskUserQuestion, ask_choice
其他:     SkillLoad, todo_write
```

### 4.2 Skill 列表 (5 个)

```
code-review  — 代码审查规范
feature-dev  — 功能开发规范
refactor     — 重构规范
test         — 运行测试→诊断→修复→重跑 (inline)
review       — git diff 审查 (inline)
```

### 4.3 新增模块

```
src/repair/
├── index.ts         # 统一导出
├── truncation.ts    # JSON 截断修复
├── scavenge.ts      # reasoning_content 捞取 tool call
└── storm.ts         # 重复调用抑制
```

---

## 五、仍需改进的方向

| 优先级 | 项目 | 改动量 | 说明 |
|:--:|------|:--:|------|
| 1 | Flash-first 默认模型 | ~10行 | 当前默认 Pro，改为 Flash 可大幅降低成本 |
| 2 | 失败信号自动升级 Pro | ~30行 | 复用已有 `toolErrors`，统计后触发升级 |
| 3 | 成本徽章 (TUI) | ~40行 | 复用已有 `usage` 数据，UI 渲染 |
| 4 | 三区上下文分区 | ~200行 | 长期架构优化，需要完整重构 |
| 5 | 子 agent (subagent) | ~300行 | 需要独立循环 + 事件桥接 |

---

## 六、与 Reasonix 的差距对照

| 维度 | 优化前 | 优化后 | Reasonix |
|------|:--:|:--:|:--:|
| 工具数 | 9 | **20** | 29 |
| Skill 数 | 3 | **5** | 5 (builtin) |
| 缓存命中率优化 | 无 | ✅ | ✅ |
| 工具结果截断 | 无 | ✅ head+tail 6000 | ✅ 3000 tokens |
| Compaction 模型 | Pro | ✅ Flash | ✅ Flash |
| 修复管道 | 无 | ✅ 3/4 pass | ✅ 4/4 pass |
| 并行调度 | 无 | ✅ 11 工具并行 | ✅ |
| 上下文预检 | 无 | ✅ | ✅ |
| 子 agent | 无 | ❌ | ✅ |
| 三区分区 | 无 | ❌ | ✅ |
| MCP | 无 | ❌ | ✅ |
| 持久化记忆 | 无 | ❌ | ✅ |
| 计划审批 | 无 | ❌ | ✅ |
