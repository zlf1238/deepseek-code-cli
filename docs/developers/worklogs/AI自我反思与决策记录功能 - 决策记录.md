# AI 自我反思与决策记录功能 — 决策记录

通过 `/learn` 和 `/worklog` 两个斜杠命令，让 AI 在对话结束后自动总结经验教训和设计决策，形成持久记忆和开发文档。

---

## 一、问题背景

### 1.1 痛点

AI 在长时间对话中反复犯同类错误：

| # | 痛点 | 影响 |
|---|------|------|
| 1 | 调错工具（如该用 gitnexus_query 却用了 grep） | 浪费 token 和轮次 |
| 2 | 写错命令（如相对路径被 rtk 拦截） | 用户需手动纠正 |
| 3 | 重复调用（同一文件 read 多次） | 上下文浪费 |
| 4 | 违反已知规则（AGENTS.md 中的经验被忽略） | 规则形同虚设 |
| 5 | 推理走弯路（探索错误方向后回来） | 延迟高 |
| 6 | 设计决策丢失（讨论完就忘了为什么选这个方案） | 后续维护无据可查 |

### 1.2 现状

项目已有 AGENTS.md（150行）和 docs/developers/worklogs/（8份文档），但全部靠人工手写，无自动机制。

---

## 二、决策思路

### 2.1 `/learn` 触发方式

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 手动命令 | 用户输入 `/learn` 触发 | 安全可控，用户决定时机 | 依赖用户主动 |
| B. 会话结束建议 | 会话结束时自动检测新模式，推送通知建议用户执行 | 不错过学习机会 | 增加会话结束逻辑 |
| C. 全自动 | 自动识别 + 自动写入 AGENTS.md | 零用户操作 | 可能写入错误经验，污染 AGENTS.md |

**选 A**。理由：
- AGENTS.md 被烘焙进 system prompt，错误内容会永久影响后续所有会话
- 需要用户审核才能写入，确保经验质量
- 实现简单，改动最小

### 2.2 新经验生效时机

AGENTS.md 只在 `createSession` 时通过 `loadAgentInstructions()` 加载（`session.ts:838`），`replySession` 不重新加载。

| 策略 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 下个新会话生效 | 写入后提示用户"下次新会话生效" | 实现简单，不破坏现有假设 | 当前会话看不到 |
| B. 刷新当前会话 | 写入后追加 system 消息到当前会话 | 当前会话也能受益 | 打破 system prompt 不可变性 |

**选 A**。system prompt 不应在对话中途变更。

### 2.3 `/learn` 反思维度

初始只覆盖"工具调用失败"。用户提出应扩展到：

- **工具调用失败** — exitCode、rtk 拦截、空结果
- **工具选择** — 是否用了最优工具
- **重复调用** — 同工具同参数多次调用
- **违反规则** — 违反 AGENTS.md 已知规则
- **推理冗余** — 探索了错误方向
- **并行机会** — 本可并行却串行
- **上下文浪费** — 读取大量无关文件
- **更优方案** — 换思路是否能更高效

决策：8 维度全部纳入，覆盖 AI 可从对话历史中自我诊断的所有方面。

### 2.4 `/worklog` 命令设计

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A. 复用斜杠命令模式 | 和 `/learn` 同一套路，handleSlashSelection 中处理 | 实现统一，维护简单 | — |
| B. 独立工具 handler | 专门写 handler，结构化参数 | 可传参（如指定标题） | 复杂度高，模型难构造 |

**选 A**。`/learn` 和 `/worklog` 本质相同：发送预定义提示文本给 AI，让 AI 自主完成。

---

## 三、方案设计

### 3.1 斜杠命令注册 (`slashCommands.ts`)

```typescript
export type SlashCommandKind = 
  "skill" | "skills" | "model" | "thinking" | "autoSwitch" 
  | "verbose" | "new" | "resume" | "exit" 
  | "learn" | "worklog";

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  // ... 原有命令 ...
  { kind: "learn",   name: "learn",   label: "/learn",   
    description: "从本轮对话的错误中学习，总结并写入 AGENTS.md" },
  { kind: "worklog", name: "worklog", label: "/worklog", 
    description: "总结本轮对话的决策过程，生成工作日志到 docs/developers/worklogs" },
];
```

### 3.2 命令分发 (`PromptInput.tsx`)

在 `handleSlashSelection` 中为 `learn` 和 `worklog` 分别构造提示文本，调用 `onSubmit` 作为用户消息发送：

```typescript
if (item.kind === "learn") {
  clearSlashToken();
  const learnPrompt = [
    "请回顾本轮对话，从以下维度反思并总结改进经验：",
    "",
    "1. 工具调用失败 ...",
    "2. 工具选择 ...",
    // ... 8 维度
    "",
    "步骤：",
    "1. 先用 read 读取 AGENTS.md ...",
    "2. 回顾本轮对话，逐维度检查",
    "3. 将新模式总结为经验条目 ...",
    "4. 用 edit 追加到《实战经验手册》末尾",
    "",
    "只总结本轮新出现的、尚未被记录的模式。",
    "修改后的 AGENTS.md 将在下一个新会话中生效。"
  ].join("\n");
  onSubmit({ text: learnPrompt, imageUrls: [], selectedSkills: [] });
  return;
}

if (item.kind === "worklog") {
  clearSlashToken();
  const worklogPrompt = [
    "请回顾本轮对话，将决策过程总结为工作日志文档。",
    "",
    "步骤：",
    "1. 先 read 一份现有文档了解格式",
    "2. 回顾本轮对话，梳理关键决策点 ...",
    "3. 按结构组织文档 ...",
    "4. 文件名格式：主题关键词 - 决策记录.md",
    "5. 用 write 写入 docs/developers/worklogs/ 目录",
    "",
    "注意：已有文档中记录过的决策不再重复；只总结本轮新决策。"
  ].join("\n");
  onSubmit({ text: worklogPrompt, imageUrls: [], selectedSkills: [] });
  return;
}
```

### 3.3 数据流

```
用户输入 /learn
  → handleSlashSelection("learn")
    → 构造 learnPrompt（8 维度 + 4 步骤）
    → onSubmit({ text: learnPrompt })
      → handlePrompt → sessionManager.handleUserPrompt(prompt)
        → AI 收到 learnPrompt 作为用户消息
          → AI 回顾对话历史
          → AI 读取 AGENTS.md
          → AI 用 edit 追加新经验
```

### 3.4 中文引号编码问题

写入文件时中文引号 `""` 退化为 ASCII `"`，导致 JS 字符串语法错误。

**解决**：用 Python 脚本将 `\u201c` / `\u201d` 替换为书名号 `\u300a` / `\u300b`。后续所有提示文本直接使用《》避免问题。

---

## 四、文件修改统计

```
 src/ui/slashCommands.ts      | +12 行 (类型 + 2个命令定义)
 src/ui/PromptInput.tsx       | +32 行 (learn + worklog 处理逻辑)
 src/tests/slashCommands.test.ts |  +4 行 (期望值更新)
 3 files, ~48 行增量
```

| 文件 | 改动 |
|------|------|
| `src/ui/slashCommands.ts` | `SlashCommandKind` 类型新增 `"learn"` `"worklog"`；`BUILTIN_SLASH_COMMANDS` 新增两个命令条目 |
| `src/ui/PromptInput.tsx` | `handleSlashSelection` 新增 `learn` 和 `worklog` 分支，各构造提示文本后通过 `onSubmit` 发送 |
| `src/tests/slashCommands.test.ts` | `builtinNames` 和 `matchedNames` 期望值追加 `"learn"` 和 `"worklog"` |

---

## 五、相关文件

| 文件 | 职责 |
|------|------|
| `src/ui/slashCommands.ts` | 斜杠命令类型定义 + 内置命令列表 |
| `src/ui/PromptInput.tsx` | 命令选择处理 + 提示文本构造 |
| `src/session.ts` | `loadAgentInstructions()` — AGENTS.md 加载（`createSession` 时） |
| `AGENTS.md` | `/learn` 输出目标，烘焙进 system prompt |
| `docs/developers/worklogs/` | `/worklog` 输出目录 |
