---
name: feature-dev
description: 在 deepseek-code-cli 中开发新功能时遵循的规范、架构约束和最佳实践。适用于从头实现新功能或在现有模块上扩展。
---

# Feature Development — deepseek-code-cli

## 项目架构速览

```
deepseek-code-cli/
│
├── src/                          # 源代码
│   ├── cli.tsx                   # 入口：解析命令行参数，渲染 Ink App
│   │
│   ├── session.ts                # 核心：会话管理、LLM 交互循环、消息持久化（~2000+ 行）
│   │
│   ├── prompt.ts                 # 系统提示词组装、工具定义（JSON Schema）、技能注入
│   │   ├── getSystemPrompt()     # 组装完整系统提示词（含工具文档 + 运行时上下文）
│   │   ├── getTools()            # 返回所有工具定义（按模型类型过滤）
│   │   ├── getCompactPrompt()    # 会话压缩提示词
│   │   ├── getFlashAutoSwitchMessage()  # 自动切 flash 时的适配消息
│   │   └── (常量) SYSTEM_PROMPT_BASE / SYSTEM_PROMPT_FLASH / FLASH_TOOL_NAMES
│   │
│   ├── settings.ts               # 配置读取与写入 (~/.deepseek-code/settings.json)
│   ├── model-capabilities.ts     # 模型选择策略（pro/flash 自动切换逻辑）
│   ├── openai-thinking.ts        # 思考模式的请求选项构建
│   ├── notify.ts                 # 任务完成通知（桌面通知）
│   ├── updateCheck.ts            # npm 更新检查
│   │
│   ├── tools/                    # 工具执行器层（每个工具一个 handler）
│   │   ├── executor.ts           # 工具调用调度器：ToolExecutor 类
│   │   │   ├── registerToolHandlers()  # 注册所有 handler 到 Map
│   │   │   ├── executeToolCalls()     # 批量执行工具调用
│   │   │   ├── parseToolCall()        # 解析原始 toolCall
│   │   │   ├── parseToolArguments()   # JSON 参数解析
│   │   │   └── formatToolResult()     # 结果序列化
│   │   │
│   │   ├── runtime.ts            # 工具运行时：executeValidatedTool() + Zod schema 工具函数
│   │   ├── state.ts              # 文件状态追踪（FileState / FileSnippet）+ 会话级别缓存
│   │   ├── file-utils.ts         # 文件读写工具函数（编码检测、行尾检测）
│   │   │
│   │   ├── bash-handler.ts           # Bash 命令执行（spawn + marker + cwd 追踪）
│   │   ├── read-handler.ts           # 文件读取（文本/图片/PDF/Notebook）
│   │   ├── write-handler.ts          # 文件写入（含 content repair）
│   │   ├── edit-handler.ts           # 文件编辑（范围匹配 + snippet 定位）
│   │   ├── glob-handler.ts           # 文件 glob 搜索
│   │   ├── grep-handler.ts           # 内容 grep 搜索
│   │   ├── ask-user-question-handler.ts  # 用户提问弹窗
│   │   ├── web-search-handler.ts     # 网络搜索（调用外部脚本）
│   │
│   ├── ui/                       # Ink React 组件（终端 UI，React 17 + Ink 3）
│   │   ├── App.tsx               # 根组件：布局 + 路由（会话列表/对话视图）
│   │   ├── PromptInput.tsx       # 输入框：键盘事件 + slash 命令
│   │   ├── MessageView.tsx       # 消息展示：markdown 渲染 + 分步指示器
│   │   ├── SessionList.tsx       # 会话列表：切换/删除/重命名
│   │   ├── AskUserQuestionPrompt.tsx  # 用户提问弹窗组件
│   │   ├── WelcomeScreen.tsx     # 欢迎页面
│   │   ├── UpdatePrompt.tsx      # 更新提示组件
│   │   ├── loadingText.ts        # 加载状态文字（动画效果）
│   │   ├── markdown.ts           # Markdown 文本渲染与语法高亮
│   │   ├── promptBuffer.ts       # 输入缓冲管理
│   │   ├── slashCommands.ts      # "/" 斜杠命令解析与补全
│   │   ├── thinkingState.ts      # 思考状态展示（深色/浅色块）
│   │   ├── clipboard.ts          # 剪贴板工具函数
│   │   └── askUserQuestion.ts    # 用户提问数据模型
│   │
│   └── tests/                    # 测试文件（tsx --test，Node 内置 test runner）
│       ├── prompt.test.ts             # prompt 相关测试（工具数、系统提示词内容）
│       ├── session.test.ts            # 会话管理测试
│       ├── tool-handlers.test.ts      # 工具处理器测试（read/write/edit）
│       ├── web-search-handler.test.ts # 网络搜索工具测试
│       ├── openai-thinking.test.ts    # 思考模式测试
│       ├── settings-and-notify.test.ts # 配置与通知测试
│       ├── updateCheck.test.ts        # 更新检查测试
│       ├── askUserQuestion.test.ts    # 用户提问 UI 测试
│       ├── clipboard.test.ts          # 剪贴板测试
│       ├── completionSummary.test.ts  # 完成摘要测试
│       ├── loadingText.test.ts        # 加载动画测试
│       ├── markdown.test.ts           # Markdown 渲染测试
│       ├── messageView.test.ts        # 消息视图测试
│       ├── promptBuffer.test.ts       # 输入缓冲测试
│       ├── promptInputKeys.test.ts    # 输入框按键测试
│       ├── sessionList.test.ts        # 会话列表测试
│       ├── slashCommands.test.ts      # 斜杠命令测试
│       ├── thinkingState.test.ts      # 思考状态测试
│       └── welcomeScreen.test.ts      # 欢迎页面测试
│
├── docs/                         # 工具文档（Markdown，供 LLM 读取注入提示词）
│   └── tools/                    # 每个工具的用法说明 + JSON Schema
│       ├── bash.md
│       ├── read.md
│       ├── write.md
│       ├── edit.md
│       ├── glob.md
│       ├── grep.md
│       ├── ask-user-question.md
│       └── web-search.md
│
├── .deepseek-code/               # 内置技能配置
│   └── skills/
│       ├── feature-dev/SKILL.md  # 本文件：功能开发规范
│       ├── refactor/SKILL.md     # 重构规范
│       └── code-review/SKILL.md  # 代码审查规范
│
├── tsconfig.json                 # strict: true, ES2022, commonjs, react-jsx
├── package.json                  # Ink 3 + React 17（⚠️ 不要升级）
└── .gitignore
```

### 核心类型定义速查

所有核心类型定义在以下文件中：

| 文件 | 关键导出类型 |
|------|------------|
| `src/tools/executor.ts` | `ToolHandler`, `ToolCall`, `ToolExecutionContext`, `ToolExecutionResult`, `ToolExecutionHooks` |
| `src/tools/runtime.ts` | `executeValidatedTool()`, `ValidationResult`, `semanticBoolean()`, `semanticInteger()` |
| `src/tools/state.ts` | `FileState`, `FileSnippet` |
| `src/tools/file-utils.ts` | `FileReadMetadata` |
| `src/session.ts` | `SessionMessage`, `MessageMeta` |
| `src/prompt.ts` | `ToolDefinition` |

---

## 开发新功能的步骤

### 1. 先读、再写

在创建或修改任何文件之前，先读取相关的现有文件了解模式和约定：

- 同类功能的文件（例如新增 UI 组件前先读一个已有的 UI 组件）
- 核心接口定义（特别是 `src/session.ts` 中的类型）
- 测试文件了解如何测试

### 2. 类型安全

- 项目使用 `strict: true`，**禁止使用 `any`**。优先用 `unknown` + 类型守卫。
- 类型定义放在与使用处最近的**同一个文件**中（内聚）。如果多个文件共用，提取到独立 `.ts` 文件。
- 使用 `isUsageRecord()` 等工具函数模式做类型守卫（参考 `session.ts` 中的模式）。
- 导出类型使用 `export type` 语法（防止编译后残留）。

### 3. React Ink 组件规范

- 使用 **React 17 + Ink 3**（不是 React 18+，注意 hooks 兼容性）
- 组件必须是**函数组件**（`const MyComp: React.FC<Props> = ...`）
- 状态管理：
  - 使用 `useState` / `useReducer`（Ink 3 不支持 React 18 的新 hooks）
  - 全局状态通过 `App.tsx` 的 props 逐层传递，或通过 `context`
  - **避免不必要的 re-render**，Ink 的渲染开销比 DOM 大
- 键盘事件：
  - 使用 `useInput` hook（来自 `ink`）
  - 处理 `ctrl+c`、`enter`、`escape` 等快捷键时，**不要吞掉默认行为**除非必要
  - 示例模式见 `PromptInput.tsx`

### 4. 工具执行器模式

新增工具调用能力的标准步骤（**共 5 步**）：

```
步骤 ① ──→ src/tools/xxx-handler.ts      # 创建 handler 文件
步骤 ② ──→ src/tools/executor.ts         # 注册 handler
步骤 ③ ──→ src/prompt.ts                 # 注册工具定义（JSON Schema）
步骤 ④ ──→ src/prompt.ts                 # 更新 FLASH_TOOL_NAMES（如需 flash 兼容）
步骤 ⑤ ──→ docs/tools/xxx.md             # 创建工具文档
```

#### 步骤①：创建 handler 文件 `src/tools/xxx-handler.ts`

遵循以下 handler 签名：

```typescript
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

export async function handleXxxTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // 1. 参数解析与校验
  const param = typeof args.param === "string" ? args.param : "";
  if (!param.trim()) {
    return { ok: false, name: "xxx", error: "Missing required \"param\" string." };
  }

  // 2. 执行核心逻辑（spawn / fs / 等）
  // 注意：使用 context.projectRoot 作为工作目录

  // 3. 返回结构化结果
  return {
    ok: true,
    name: "xxx",
    output: resultOutput,
    metadata: { ... }
  };
}
```

**handler 编写要点**：

- `args` 是所有参数的大一统 `Record<string, unknown>`，参数解析时务必做类型守卫（typeof 检查）
- `context` 中包含 `sessionId`、`projectRoot`、`toolCall`、`createOpenAIClient`、`onProcessStart`、`onProcessExit`
- 对于执行外部进程的工具（如 bash、webSearch），使用 `spawn` 而非 `exec`，并通过 `context.onProcessStart/onProcessExit` 报告进程生命周期
- 捕获异常时，用 `isAbortLikeError(error)` 判断是否为中断信号（如 `AbortError`），是则重新抛出
- handler 可以是同步或异步函数

**可选：使用 Zod 校验参数**（参考 `runtime.ts` 的 `executeValidatedTool()`）：

```typescript
import { z } from "zod";
import { executeValidatedTool } from "./runtime";

const mySchema = z.object({
  param1: z.string().min(1, "param1 is required"),
  param2: z.number().int().optional()
});

export async function handleXxxTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return executeValidatedTool("xxx", mySchema, args, context, handler);
}

async function handler(
  input: z.infer<typeof mySchema>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // 此时 input 已通过类型校验
}
```

两处修改：

```typescript
// 1. 文件顶部添加 import
import { handleXxxTool } from "./xxx-handler";

// 2. registerToolHandlers() 方法中添加
this.toolHandlers.set("xxx", handleXxxTool);
```

⚠️ 注册的 tool name（如 `"xxx"`）必须与步骤③的 `name` 一致，且与步骤⑤的文档文件名对应。

#### 步骤③：在 `prompt.ts` 的 `getTools()` 中注册工具定义（JSON Schema）

在 `getTools()` 函数末尾（`WebSearch` 工具之后、flash 过滤逻辑之前）添加：

```typescript
tools.push({
  type: "function",
  function: {
    name: "xxx",
    description: "工具的描述文字，会展示给 LLM 使用",
    parameters: {
      type: "object",
      properties: {
        param1: {
          type: "string",
          description: "参数说明",
        },
      },
      required: ["param1"],
      additionalProperties: false,
    },
  },
});
```

**要点**：

- `name` **必须全小写**（LLM 调用时大小写敏感）
- `description` 要清晰概括工具能力，帮助 LLM 判断何时使用
- `required` 数组定义必填参数
- `additionalProperties: false` 防止 LLM 传入未定义的参数

#### 步骤④：更新 `FLASH_TOOL_NAMES`

如果该工具应在 flash 模式下继续可用（即不依赖 thinking 能力），将其加入 `FLASH_TOOL_NAMES`：

```typescript
const FLASH_TOOL_NAMES = new Set([
  "read", "write", "edit", "glob", "grep", "bash", "xxx"
]);
```

**判断标准**：如果工具需要复杂分析、多步骤推理或网络能力，不要加入 flash 模式。

#### 步骤⑤：创建工具文档 `docs/tools/xxx.md`

文档格式遵循已有的 `.md` 文件模式：

```markdown
## Xxx

工具的职责描述和适用场景。

使用方法：
- 参数说明
- 使用注意事项

JSON schema:

```json
{
  "type": "object",
  "properties": { ... },
  "required": [...],
  "additionalProperties": false
}
```
```

文档会被 `prompt.ts` 的 `readToolDocs()` 读取并注入到系统提示词中，让 LLM 知道如何使用该工具。

### 5. 错误处理模式

```typescript
// 参数校验错误 — 同步返回
if (something.wentWrong) {
  return { ok: false, name: "my-tool", error: "具体的错误信息" };
}

// 异步错误 — try/catch
try {
  await doSomething();
} catch (error) {
  if (isAbortLikeError(error)) throw error; // 传播中断信号
  return { ok: false, name: "my-tool", error: String(error) };
}
```

**注意**：工具执行结果遵循统一序列化格式：

```typescript
JSON.stringify({ ok: true/false, name, output?, error?, metadata?, awaitUserResponse? })
```

### 6. 更新测试

- 测试框架：`tsx --test`（Node 内置 test runner）
- 测试文件放在 `src/tests/`，命名为 `xxx.test.ts`
- **至少为新增的纯函数写单元测试**
- 测试模式参考已有测试（例如 `prompt.test.ts`、`session.test.ts`、`tool-handlers.test.ts`）
- **如果新增工具导致 `prompt.test.ts` 中的工具计数断言失败**，更新 `prompt.test.ts` 中的数字（如 `8→9`、`6→7`）和断言内容
- 运行测试：`npx tsx --test src/tests/相关测试.test.ts`

### 7. 会话与消息模式

新增功能如果涉及消息交互，需理解 `session.ts` 中的消息模型：

- `SessionMessage.role`: `"system" | "user" | "assistant" | "tool"`
- `MessageMeta`: 附带元数据（`asThinking`、`isSummary`、`skill`、`isStepIndicator` 等）
- 工具执行结果用 `JSON.stringify({ ok, name, output, error, metadata })` 格式
- 用户交互（提问）通过 `AskUserQuestion` 工具，结果中包含 `awaitUserResponse: true`

### 8. 模型兼容性

项目支持双模型切换（pro → flash）：

- `deepseek-v4-pro`：完整能力（thinking + 所有工具）
- `deepseek-v4-flash`：快速模式（仅文件操作 + bash，无 thinking）
- 如果新功能依赖非文件操作工具，确保在 flash 模式下有降级/提示行为
- 新增工具时在 `prompt.ts` 的 `FLASH_TOOL_NAMES` 中判断是否对 flash 暴露

### 9. 避免的陷阱

- ❌ 不要修改 `package.json` 直接依赖项（Ink 3, React 17 等需保持兼容）
- ❌ 不要破坏 `tsconfig.json` 的 `strict: true`
- ❌ 不要引入外部重度依赖（优先用 Node 内置 API）
- ❌ 不要在 UI 组件中做 IO/网络操作（通过回调/事件驱动）
- ❌ 不要在系统提示词中硬编码具体文件路径（通过 `getRuntimeContext()` 动态注入）
- ✅ 优先使用 `fs/promises` 的 API（项目已有 `fs` 同步调用模式，视情况统一）
- ✅ 工具注册名（handler 的 map key、prompt 的 name）三者必须完全一致
- ✅ 修改 `prompt.test.ts` 中的工具计数断言时，同步更新测试描述文字
