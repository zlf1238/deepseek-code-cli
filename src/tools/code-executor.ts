/**
 * spawn_code_executor 工具 —— Supervisor-Worker 架构的执行端。
 *
 * 当 autoSwitch 启用且当前模型为 Pro 时，Pro（Supervisor）可调用此工具
 * 将代码修改委派给 Flash 子智能体执行。子智能体拥有隔离的上下文：
 * 仅包含 system prompt + 任务指令 + 文件内容，不影响主会话的 prefix-cache。
 *
 * 借鉴 Reasonix subagent.ts: 隔离循环、工具范围限制、迭代上限、usage 追踪。
 */

import type OpenAI from "openai";
import { buildThinkingRequestOptions } from "../openai-thinking";
import type { PricingSnapshot } from "../model-capabilities";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

/** 子智能体的系统提示词 —— 纯执行，不扩展范围 */
export const CODE_EXECUTOR_SYSTEM = `You are a code executor sub-agent. Your ONLY job is to execute the parent's modification instruction precisely.

Rules:
1. Read the target file first using read_file to see current contents
2. Apply the modification using edit_file with SEARCH/REPLACE blocks
3. Do NOT expand scope — change ONLY what the instruction specifies
4. Do NOT add "improvements", refactoring, or extra fixes beyond the instruction
5. If the instruction is unclear or the target code cannot be found, return what's unclear instead of guessing
6. Return a one-sentence summary of changes made, followed by the list of files modified

You have NO conversation context — only the file content and the task instruction.`;

/** 子智能体最大迭代次数 */
const MAX_ITERS = 8;

/** 子智能体的工具定义（仅 read_file + edit_file + write_file） */
function getSubagentTools() {
  return [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取文件内容。",
        parameters: {
          type: "object" as const,
          properties: {
            file_path: {
              type: "string" as const,
              description: "文件的绝对路径。",
            },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "edit_file",
        description: "在文件中执行精确的 SEARCH/REPLACE 范围替换。",
        parameters: {
          type: "object" as const,
          properties: {
            file_path: {
              type: "string" as const,
              description: "要修改的文件的绝对路径。",
            },
            old_string: {
              type: "string" as const,
              description: "要替换的确切文本。",
            },
            new_string: {
              type: "string" as const,
              description: "替换后的文本。",
            },
            replace_all: {
              type: "boolean" as const,
              description: "是否替换所有匹配项（默认 false）。",
            },
          },
          required: ["file_path", "old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "write_file",
        description: "创建新文件或覆写现有文件。",
        parameters: {
          type: "object" as const,
          properties: {
            file_path: {
              type: "string" as const,
              description: "文件的绝对路径。",
            },
            content: {
              type: "string" as const,
              description: "完整的文件内容。",
            },
          },
          required: ["file_path", "content"],
          additionalProperties: false,
        },
      },
    },
  ];
}

/** 辅助：累积 usage 对象 */
function accumulateUsage(
  acc: Record<string, number>,
  usage: unknown,
): Record<string, number> {
  if (!usage || typeof usage !== "object") return acc;
  const u = usage as Record<string, unknown>;
  const result = { ...acc };
  const keys = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
  ] as const;
  for (const k of keys) {
    if (typeof u[k] === "number") {
      result[k] = (result[k] ?? 0) + (u[k] as number);
    }
  }
  return result;
}

/** 辅助：计算子智能体费用 */
function calculateSubagentCost(
  usage: Record<string, number>,
  pricing?: PricingSnapshot,
): number {
  if (!pricing) return 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;

  let cost = 0;
  cost += (hit / 1_000_000) * pricing.inputCacheHitPricePerMillion;
  cost += (miss / 1_000_000) * pricing.inputCacheMissPricePerMillion;
  // 未区分缓存/未缓存的 prompt token 按 miss 价计
  const uncategorized = Math.max(0, prompt - hit - miss);
  cost += (uncategorized / 1_000_000) * pricing.inputCacheMissPricePerMillion;
  cost += (completion / 1_000_000) * pricing.outputPricePerMillion;
  return cost;
}

export async function handleCodeExecutorTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  // ── 1. 参数解析 ──
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const filePath =
    typeof args.file_path === "string" ? args.file_path.trim() : "";
  const extraContext =
    typeof args.context === "string" ? args.context.trim() : "";

  if (!task) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error: "Missing required 'task' argument — the sub-agent has nothing to do.",
    };
  }
  if (!filePath) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error: "Missing required 'file_path' argument — the sub-agent needs to know which file to modify.",
    };
  }

  // ── 2. 获取 Flash client ──
  // 借用 Reasonix: 子智能体默认 Flash，失败时回退到默认 client
  const flashInfo = context.createOpenAIClient?.("deepseek-v4-flash");
  const defaultInfo = context.createOpenAIClient?.();
  const client: OpenAI | null =
    flashInfo?.client ?? defaultInfo?.client ?? null;
  const model = flashInfo?.client
    ? (flashInfo.model ?? "deepseek-v4-flash")
    : (defaultInfo?.model ?? "deepseek-v4-flash");
  const baseURL = flashInfo?.baseURL ?? defaultInfo?.baseURL;
  const pricing = flashInfo?.pricing ?? defaultInfo?.pricing;
  const thinkingEnabled = true;
  const reasoningEffort: "high" | "max" = "high";

  if (!client) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error: "No API client available for code executor sub-agent.",
    };
  }

  // ── 3. 构建子智能体消息 ──
  let userContent = `Modification task: ${task}\nTarget file: ${filePath}`;
  if (extraContext) {
    userContent += `\n\nAdditional context from supervisor:\n${extraContext}`;
  }

  const messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }> = [
    { role: "system", content: CODE_EXECUTOR_SYSTEM },
    { role: "user", content: userContent },
  ];

  // ── 4. 子智能体主循环 ──
  const startedAt = Date.now();
  let toolIters = 0;
  let totalUsage: Record<string, number> = {};
  const thinkingOptions = buildThinkingRequestOptions(
    thinkingEnabled,
    baseURL,
    reasoningEffort,
  );

  // 导入 handler（动态导入避免循环依赖）
  const { handleReadTool } =
    await import("./read-handler");
  const { handleEditTool } =
    await import("./edit-handler");
  const { handleWriteTool } =
    await import("./write-handler");

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // API 调用
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = (await client.chat.completions.create({
        model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: getSubagentTools() as OpenAI.Chat.Completions.ChatCompletionTool[],
        ...thinkingOptions,
      })) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        name: "spawn_code_executor",
        error: `Sub-agent API call failed: ${msg}`,
        metadata: {
          subagentModel: model,
          subagentUsage: totalUsage,
          subagentElapsedMs: Date.now() - startedAt,
        },
      };
    }

    // 追踪 usage
    totalUsage = accumulateUsage(totalUsage, response.usage);

    const choice = response.choices?.[0];
    const message = choice?.message;
    const content = (message as { content?: string | null } | undefined)
      ?.content ?? "";
    const toolCalls =
      (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? null;

    // 无工具调用 → 子智能体完成任务
    if (!toolCalls || toolCalls.length === 0) {
      const elapsedMs = Date.now() - startedAt;
      const costUsd = calculateSubagentCost(totalUsage, pricing);

      return {
        ok: true,
        name: "spawn_code_executor",
        output: JSON.stringify({
          success: true,
          output: content || "[sub-agent completed without output]",
          turns: iter + 1,
          tool_iters: toolIters,
          elapsed_ms: elapsedMs,
          cost_usd: Number(costUsd.toFixed(6)),
        }),
        metadata: {
          subagentModel: model,
          subagentUsage: totalUsage,
          subagentCostUsd: costUsd,
          subagentElapsedMs: elapsedMs,
        },
      };
    }

    // 记录工具调用计数
    toolIters += toolCalls.length;

    // 追加 assistant 消息（含 tool calls）
    messages.push({
      role: "assistant",
      content: content ?? "",
      tool_calls: toolCalls,
    });

    // 执行每个工具调用
    for (const tc of toolCalls as Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>) {
      const fn = tc.function;
      if (!fn?.name) continue;

      const toolName = fn.name;
      const rawArgs = fn.arguments ?? "{}";
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: tc.id ?? "",
          content: JSON.stringify({
            error: `Failed to parse tool arguments: ${rawArgs.slice(0, 200)}`,
          }),
        });
        continue;
      }

      // 分发到对应的 handler
      let result: ToolExecutionResult;
      switch (toolName) {
        case "read_file":
          result = await handleReadTool(parsedArgs, {
            sessionId: context.sessionId,
            projectRoot: context.projectRoot,
            toolCall: {
              id: tc.id ?? "",
              type: "function",
              function: { name: "read_file", arguments: rawArgs },
            },
          });
          break;
        case "edit_file":
          result = await handleEditTool(parsedArgs, {
            sessionId: context.sessionId,
            projectRoot: context.projectRoot,
            toolCall: {
              id: tc.id ?? "",
              type: "function",
              function: { name: "edit_file", arguments: rawArgs },
            },
          });
          break;
        case "write_file":
          result = await handleWriteTool(parsedArgs, {
            sessionId: context.sessionId,
            projectRoot: context.projectRoot,
            toolCall: {
              id: tc.id ?? "",
              type: "function",
              function: { name: "write_file", arguments: rawArgs },
            },
          });
          break;
        default:
          result = {
            ok: false,
            name: toolName,
            error: `Sub-agent tool not allowed: ${toolName}. Only read_file, edit_file, write_file are permitted.`,
          };
      }

      // 追加 tool result 消息
      const toolContent = JSON.stringify({
        ok: result.ok,
        name: result.name,
        output: result.output,
        error: result.error,
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id ?? "",
        content: toolContent,
      });
    }
  }

  // ── 5. 超出迭代上限 ──
  const elapsedMs = Date.now() - startedAt;
  const costUsd = calculateSubagentCost(totalUsage, pricing);

  return {
    ok: false,
    name: "spawn_code_executor",
    error: `Sub-agent exceeded maximum ${MAX_ITERS} iterations without completing the task.`,
    metadata: {
      subagentModel: model,
      subagentUsage: totalUsage,
      subagentCostUsd: costUsd,
      subagentElapsedMs: elapsedMs,
    },
  };
}
