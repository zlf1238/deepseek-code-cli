\# AI Project Context Guide (Optimized for LLMs)



\*\*项目概述 (Project Overview)\*\*

本项目是一个基于 Node.js 和 React (终端 UI 库，如 Ink) 构建的 \*\*AI CLI 助手 (Command Line Interface AI Assistant)\*\*。它不仅提供聊天界面，还允许 AI 模型通过工具调用 (Function Calling) 在用户的本地系统上执行操作（如读写文件、执行 Bash 命令、搜索网页）。



\*\*技术栈推断 (Tech Stack)\*\*

\- \*\*运行环境\*\*: Node.js

\- \*\*UI 框架\*\*: React (Terminal UI, 例如 Ink) + TypeScript

\- \*\*AI 集成\*\*: 支持 OpenAI (包含 Thinking 模型支持) 及可能的多模型适配。



\---



\## 核心模块与目录结构 (Core Modules \& Structure)



为减少 Token 消耗，以下仅列出关键模块及其职责：



\### 1. `src/` (根目录 - 核心架构)

\- `cli.tsx`: 应用程序入口点，初始化 CLI 界面和参数。

\- `session.ts`: 会话状态管理，维护历史记录和上下文。

\- `settings.ts`: 本地配置文件管理。

\- `prompt.ts`: 系统提示词构建器。

\- `openai-thinking.ts` / `model-capabilities.ts`: 处理大语言模型 (LLM) 的 API 交互，特化处理具有 "Thinking/Reasoning" 能力的模型。

\- `notify.ts` / `updateCheck.ts`: 系统通知和版本更新检查。



\### 2. `src/ui/` (终端界面层)

负责渲染命令行 UI 和处理用户按键输入。

\- \*\*核心组件\*\*: `App.tsx` (主容器), `MessageView.tsx` (消息渲染), `PromptInput.tsx` (用户输入框), `SessionList.tsx` (会话列表), `WelcomeScreen.tsx` (欢迎页)。

\- \*\*交互逻辑\*\*: `promptBuffer.ts` (输入缓冲), `slashCommands.ts` (快捷命令处理, 如 `/clear`, `/help`), `clipboard.ts` (剪贴板操作)。

\- \*\*状态与表现\*\*: `thinkingState.ts` (AI 思考状态 UI), `markdown.ts` (终端 Markdown 渲染), `loadingText.ts` (加载动画)。



\### 3. `src/tools/` (AI 工具链/执行器)

\*\*本项目的核心亮点\*\*。AI 调用的工具函数在此实际落地执行。

\- \*\*调度器\*\*: `executor.ts` (分发任务), `runtime.ts` (运行环境上下文), `state.ts` (工具执行状态)。

\- \*\*具体 Handler (工具实现)\*\*:

&#x20; - `bash-handler.ts`: 执行终端 shell 命令。

&#x20; - `edit-handler.ts` / `read-handler.ts` / `write-handler.ts`: 本地文件系统的读写与修改。

&#x20; - `glob-handler.ts` / `grep-handler.ts`: 文件搜索与内容检索。

&#x20; - `web-search-handler.ts`: 联网搜索能力。

&#x20; - `ask-user-question-handler.ts`: 允许 AI 主动中断并向用户提问获取确认/信息。

&#x20; - `file-utils.ts`: 文件处理辅助函数。



\### 4. `src/tests/` (测试套件)

包含与上述模块一一对应的 `.test.ts` 单元测试文件（如 `tool-handlers.test.ts`, `session.test.ts`），用于保障核心逻辑和 UI 组件的稳定性。



\---



\## 核心数据流 (Key Data Flow)

1\. \*\*输入\*\*: 用户在 `ui/PromptInput.tsx` 输入文本，或通过 `ui/slashCommands.ts` 触发快捷命令。

2\. \*\*处理\*\*: 输入提交给 `session.ts`，组装 `prompt.ts` 和历史记录，发送至 `openai-thinking.ts`。

3\. \*\*执行 (如果触发工具)\*\*: AI 返回 Tool Call 请求 -> `tools/executor.ts` 拦截 -> 路由至对应的 `\*-handler.ts` (如执行 `bash`) -> 获取本地系统返回结果 -> 将结果追加到对话历史，再次请求 AI。

4\. \*\*输出\*\*: AI 最终响应文本 -> `ui/MessageView.tsx` 通过 `ui/markdown.ts` 渲染到终端。



\---



\*\*如何使用此文档 (For AI Assistants)\*\*

当你处理关于本项目的开发任务时，请参考上述结构。

\- 修复 UI Bug -> 重点查看 `src/ui/`。

\- 新增 AI 能力/命令 -> 重点查看 `src/tools/` 和 `src/model-capabilities.ts`。

\- 修改对话逻辑/上下文 -> 重点查看 `src/session.ts`。

