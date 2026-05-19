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

/** 子智能体失败分类码，Supervisor 可按分类决定重试策略 */
export type SubagentFailureCode =
  | "API_ERROR"        // API 调用失败（网络/认证/服务端错误）
  | "NO_CLIENT"        // 无可用的 API 客户端
  | "NOT_FOUND"        // 目标代码在文件中未找到
  | "AMBIGUOUS"        // 指令不够明确，无法执行
  | "TIMEOUT"          // 超出最大迭代次数
  | "SCOPE_EXCEEDED";  // 子智能体尝试扩大修改范围

/** 子智能体的系统提示词 —— 纯执行，不扩展范围 */
export const CODE_EXECUTOR_SYSTEM = `你是代码执行子智能体。你唯一的职责是精确执行父智能体的修改指令。

规则：
1. 先用 read_file 读取所有目标文件，查看当前内容
2. 使用 edit_file 的 SEARCH/REPLACE 方式应用修改——按逻辑顺序处理文件。涉及 2+ 个文件的修改，优先使用 multi_edit 一次性原子完成所有编辑
3. 修改多个文件时，注意一个文件的更改如何影响其他文件（例如一个文件的类型变更可能需要同步修改调用方）
4. 不要扩大范围——只修改指令指定的内容
5. 不要添加指令之外的"改进"、重构或额外修复
6. 如果指令不明确或找不到目标代码，说明不清楚之处，不要猜测
7. 如果 edit_file 因 old_string 未找到而失败：
   a. 重新读取文件获取当前（可能已变更的）内容
   b. 调整 old_string 使其与文件中的内容完全匹配
   c. 重试编辑（每个文件最多重试 2 次——之后报告该文件失败）
8. 返回一句修改摘要，后附修改的文件列表

你没有对话上下文——只有文件内容和任务指令。

**语言要求：** 你的所有输出、思考过程和工具调用描述都必须使用中文。技术术语（如函数名、变量名）可保留原文。`;

/** Explorer 子智能体的系统提示词 —— 代码库导航式探索，GitNexus 优先 */
export const EXPLORER_SYSTEM = `你是 Explorer 子智能体。你的职责：探索代码库并返回一个精炼的答案。

## 优先级：用 GitNexus 导航，不要盲目搜索
1. gitnexus_clusters — 先理解模块分层
2. gitnexus_query — 一次调用混合搜索符号/概念
3. gitnexus_context — 符号的 360° 视图（调用者、被调用者、流程）
4. gitnexus_impact — 修改前的影响范围分析
5. gitnexus_processes — 追踪端到端执行流
仅在 GitNexus 指向的具体行上用 read_file + grep 验证。
**如果 GitNexus 工具返回空结果或错误**（项目可能尚未索引），回退到 grep + read_file 直接探索——但保持专注。

## 陷阱防范
- search_files 仅匹配文件名——不适用于"查找 X 的调用者"
- 不要多次 read_file 同一文件——一次读足范围
- GitNexus 工具能回答 80% 的问题，无需读取文件

## 尽早停止
父智能体看不到你的工具调用——过度探索是纯粹的浪费。
能回答就立即停止并交付。

## 输出格式
- 以结论开头（一段或简短要点）
- 在答案开头标记置信度：[confident] / [partial] / [uncertain]
  - [confident] = GitNexus 返回了清晰结果且已用 read_file 验证
  - [partial] = 找到部分证据但可能不完整（例如只有直接调用者，可能遗漏间接调用）
  - [uncertain] = GitNexus 失败或返回空，仅基于 grep/read_file 回答
- 引用 file:line 证据
- 如果找不到答案，说明情况并建议下一步方向
- 不要追加"如需更多信息请告知"之类的客套话
- 不要超出父智能体任务的范围

**语言要求：** 你的所有输出、思考过程和工具调用描述都必须使用中文。技术术语（如函数名、变量名）可保留原文。`;

/** 子智能体最大迭代次数（12 轮：2-5 个相关文件修改有余量，避免 8 轮短板） */
const MAX_ITERS = 12;

/** 子智能体的工具定义（默认 read_file + edit_file + write_file，可通过 allowedTools 扩展） */
function getSubagentTools(allowedTools?: string[]) {
  const toolSet = new Set(allowedTools ?? ["read_file", "edit_file", "write_file", "multi_edit"]);
  const tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    };
  }> = [];

  if (toolSet.has("read_file")) tools.push({
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取文件内容。",
      parameters: { type: "object" as const, properties: { file_path: { type: "string" as const, description: "文件的绝对路径。" } }, required: ["file_path"], additionalProperties: false },
    },
  });

  if (toolSet.has("edit_file")) tools.push({
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "在文件中执行精确的 SEARCH/REPLACE 范围替换。",
      parameters: {
        type: "object" as const,
        properties: {
          file_path: { type: "string" as const, description: "要修改的文件的绝对路径。" },
          old_string: { type: "string" as const, description: "要替换的确切文本。" },
          new_string: { type: "string" as const, description: "替换后的文本。" },
          replace_all: { type: "boolean" as const, description: "是否替换所有匹配项（默认 false）。" },
        },
        required: ["file_path", "old_string", "new_string"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("multi_edit")) tools.push({
    type: "function" as const,
    function: {
      name: "multi_edit",
      description: "在一次原子操作中编辑多个文件。每次编辑可以替换文件中某个字符串的所有匹配项或仅首个匹配项。编辑按顺序应用：如果一次编辑失败，后续编辑仍会尝试。",
      parameters: {
        type: "object" as const,
        properties: {
          edits: {
            type: "array" as const,
            description: "要执行的编辑操作列表。",
            items: {
              type: "object" as const,
              properties: {
                file_path: { type: "string" as const, description: "要编辑的文件绝对路径。" },
                old_string: { type: "string" as const, description: "要替换的文本。" },
                new_string: { type: "string" as const, description: "替换后的文本（必须与 old_string 不同）。" },
                replace_all: { type: "boolean" as const, description: "替换所有匹配项。默认 false（仅首个）。" },
                expected_occurrences: { type: "number" as const, description: "当 replace_all 为 true 时，预期的匹配次数——安全校验。" },
              },
              required: ["file_path", "old_string", "new_string"],
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  });

  if (toolSet.has("write_file")) tools.push({
    type: "function" as const,
    function: {
      name: "write_file",
      description: "创建新文件或覆写现有文件。",
      parameters: {
        type: "object" as const,
        properties: { file_path: { type: "string" as const, description: "文件的绝对路径。" }, content: { type: "string" as const, description: "完整的文件内容。" } },
        required: ["file_path", "content"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("grep")) tools.push({
    type: "function" as const,
    function: {
      name: "grep",
      description: "在文件中搜索文本或正则表达式。返回匹配行及上下文。",
      parameters: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const, description: "要搜索的文本或正则表达式。" },
          path: { type: "string" as const, description: "搜索路径，默认为项目根目录。" },
          include: { type: "string" as const, description: "文件扩展名过滤，如 \"*.ts\"。" },
        },
        required: ["pattern"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("glob")) tools.push({
    type: "function" as const,
    function: {
      name: "glob",
      description: "查找匹配 glob 模式的文件。返回匹配文件路径的列表。",
      parameters: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const, description: "用于匹配文件名的 glob 模式。" },
          path: { type: "string" as const, description: "要搜索的目录，默认为项目根目录。" },
        },
        required: ["pattern"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("bash")) tools.push({
    type: "function" as const,
    function: {
      name: "bash",
      description: "在持久化的 bash 会话中执行 shell 命令。",
      parameters: {
        type: "object" as const,
        properties: {
          command: { type: "string" as const, description: "要执行的 shell 命令" },
          description: { type: "string" as const, description: "用主动语态描述此命令的作用。" },
        },
        required: ["command"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("web_search")) tools.push({
    type: "function" as const,
    function: {
      name: "web_search",
      description: "使用自然语言查询执行网络搜索。",
      parameters: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "搜索查询。" },
        },
        required: ["query"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("web_fetch")) tools.push({
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "通过 HTTP 抓取 URL 的文本内容。",
      parameters: {
        type: "object" as const,
        properties: {
          url: { type: "string" as const, description: "要抓取的 URL。" },
          maxChars: { type: "number" as const, description: "返回的最大字符数，默认 10000。" },
        },
        required: ["url"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("directory_tree")) tools.push({
    type: "function" as const,
    function: {
      name: "directory_tree",
      description: "以树形结构列出目录内容。",
      parameters: {
        type: "object" as const,
        properties: {
          path: { type: "string" as const, description: "要列出的目录路径，默认为项目根目录。" },
          maxDepth: { type: "number" as const, description: "最大递归深度，默认为 3。" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });

  if (toolSet.has("search_files")) tools.push({
    type: "function" as const,
    function: {
      name: "search_files",
      description: "按文件名模式搜索文件。",
      parameters: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const, description: "文件名中要匹配的文本。" },
          path: { type: "string" as const, description: "搜索起始目录，默认为项目根目录。" },
          caseSensitive: { type: "boolean" as const, description: "是否区分大小写，默认 false。" },
        },
        required: ["pattern"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("get_file_info")) tools.push({
    type: "function" as const,
    function: {
      name: "get_file_info",
      description: "获取文件或目录的元信息。",
      parameters: {
        type: "object" as const,
        properties: {
          file_path: { type: "string" as const, description: "文件或目录的绝对路径。" },
        },
        required: ["file_path"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("gitnexus_query")) tools.push({
    type: "function" as const,
    function: {
      name: "gitnexus_query",
      description: "在代码库知识图谱中执行混合搜索（BM25+语义+RRF融合）。",
      parameters: {
        type: "object" as const,
        properties: {
          query: { type: "string" as const, description: "搜索查询。" },
          max_chars: { type: "number" as const, description: "返回的最大字符数，默认 8000。" },
        },
        required: ["query"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("gitnexus_context")) tools.push({
    type: "function" as const,
    function: {
      name: "gitnexus_context",
      description: "获取单个符号的 360 度视图：所有引用者、被引用者、参与的进程。",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "符号名称。" },
          max_chars: { type: "number" as const, description: "返回的最大字符数，默认 6000。" },
        },
        required: ["name"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("gitnexus_impact")) tools.push({
    type: "function" as const,
    function: {
      name: "gitnexus_impact",
      description: "变更前分析影响面：修改某个文件/符号会影响哪些进程和其他文件。",
      parameters: {
        type: "object" as const,
        properties: {
          target: { type: "string" as const, description: "要分析的目标文件路径或符号名称。" },
          symbol: { type: "string" as const, description: "可选：具体符号名称。" },
        },
        required: ["target"], additionalProperties: false,
      },
    },
  });

  if (toolSet.has("gitnexus_clusters")) tools.push({
    type: "function" as const,
    function: {
      name: "gitnexus_clusters",
      description: "从 MCP 资源读取代码库的功能聚类（Leiden 社区检测）及内聚度评分。",
      parameters: {
        type: "object" as const,
        properties: {
          cluster: { type: "string" as const, description: "可选：指定聚类名称获取成员详情。" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });

  if (toolSet.has("gitnexus_processes")) tools.push({
    type: "function" as const,
    function: {
      name: "gitnexus_processes",
      description: "列出或追踪代码库的执行流：函数调用链、事件传播路径。",
      parameters: {
        type: "object" as const,
        properties: {
          process: { type: "string" as const, description: "可选：指定进程名称读取特定的进程追踪详情。" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  });

  return tools;
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
  // prompt_tokens 统计可能少于缓存分项之和（部分 API 实现），取 max(0, 差值)
  const uncategorized = Math.max(0, prompt - (hit + miss));
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
  const extraContext =
    typeof args.context === "string" ? args.context.trim() : "";

  // 优先 file_paths 数组，回退到 file_path 单字符串（向后兼容）
  const filePaths: string[] = (() => {
    const arr = args.file_paths;
    if (Array.isArray(arr)) {
      return arr
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => x.length > 0);
    }
    const single = args.file_path;
    if (typeof single === "string" && single.trim()) return [single.trim()];
    return [];
  })();

  if (!task) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error: "Missing required 'task' argument — the sub-agent has nothing to do.",
      metadata: { failureCode: "AMBIGUOUS" as SubagentFailureCode },
    };
  }
  if (filePaths.length === 0) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error:
        "Missing required 'file_paths' argument — the sub-agent needs to know which file(s) to modify.",
      metadata: { failureCode: "AMBIGUOUS" as SubagentFailureCode },
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
  // enable_thinking 默认为 true（子智能体默认开思考，Supervisor 可通过参数关闭）
  const thinkingEnabled = typeof args.enable_thinking === "boolean" ? args.enable_thinking : true;
  const reasoningEffort: "high" | "max" = "high";
  // 解析 allowed_tools：Supervisor 可指定子智能体可用工具集
  const allowedTools: string[] | undefined = Array.isArray(args.allowed_tools)
    ? (args.allowed_tools as string[]).filter((t) => typeof t === "string")
    : undefined;
  // require_confirmation：要求 spawn 前用户确认
  const requireConfirmation = typeof args.require_confirmation === "boolean" ? args.require_confirmation : false;

  if (!client) {
    return {
      ok: false,
      name: "spawn_code_executor",
      error: "No API client available for code executor sub-agent.",
      metadata: { failureCode: "NO_CLIENT" as SubagentFailureCode },
    };
  }

  // ── 3. 构建子智能体消息 ──
  const filesList = filePaths.map((f) => `  - ${f}`).join("\n");
  let userContent = `Modification task: ${task}\nTarget files (${filePaths.length}):\n${filesList}`;
  if (extraContext) {
    userContent += `\n\nAdditional context from supervisor:\n${extraContext}`;
  }

  const messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
    /** DeepSeek thinking mode: reasoning_content 必须在后续请求中回传，否则 API 400 */
    reasoning_content?: string;
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

  // 自修正重试追踪：每个文件的 edit 失败次数
  const editRetries = new Map<string, number>();
  const MAX_EDIT_RETRIES = 2;

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
        tools: getSubagentTools(allowedTools) as OpenAI.Chat.Completions.ChatCompletionTool[],
        ...thinkingOptions,
      })) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const costUsd = calculateSubagentCost(totalUsage, pricing);
      return {
        ok: false,
        name: "spawn_code_executor",
        error: `Sub-agent API call failed: ${msg}`,
        metadata: {
          failureCode: "API_ERROR" as SubagentFailureCode,
          subagentModel: model,
          subagentUsage: totalUsage,
          subagentCostUsd: costUsd,
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
    // 提取 reasoning_content 以便后续回传（DeepSeek thinking mode 要求）
    const reasoningContent =
      (message as { reasoning_content?: string } | undefined)?.reasoning_content ?? undefined;

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

    // 追加 assistant 消息（含 tool calls，回传 reasoning_content 以满足 thinking mode 协议）
    const assistantMsg: {
      role: "assistant";
      content: string;
      tool_calls?: unknown[];
      reasoning_content?: string;
    } = {
      role: "assistant",
      content: content ?? "",
      tool_calls: toolCalls,
    };
    if (reasoningContent) {
      assistantMsg.reasoning_content = reasoningContent;
    }
    messages.push(assistantMsg);

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
        case "edit_file": {
          result = await handleEditTool(parsedArgs, {
            sessionId: context.sessionId,
            projectRoot: context.projectRoot,
            toolCall: {
              id: tc.id ?? "",
              type: "function",
              function: { name: "edit_file", arguments: rawArgs },
            },
          });
          // 自修正重试追踪：记录 edit 失败次数
          if (!result.ok && result.error) {
            const editFile = (parsedArgs.file_path as string) ?? "unknown";
            const prev = editRetries.get(editFile) ?? 0;
            editRetries.set(editFile, prev + 1);
            if (prev >= MAX_EDIT_RETRIES) {
              result = {
                ok: false,
                name: "edit_file",
                error: `${result.error}\n[已达到最大重试次数 ${MAX_EDIT_RETRIES}，请报告失败原因。]`,
                metadata: { failureCode: "NOT_FOUND" as SubagentFailureCode },
              };
            } else {
              result = {
                ...result,
                error: `${result.error}\n[重试 ${prev + 1}/${MAX_EDIT_RETRIES}：请 re-read 文件后调整 old_string]`,
              };
            }
          } else if (result.ok) {
            // 成功后重置该文件的重试计数
            const editFile = (parsedArgs.file_path as string) ?? "unknown";
            editRetries.delete(editFile);
          }
          break;
        }
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
            metadata: { failureCode: "SCOPE_EXCEEDED" as SubagentFailureCode },
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
      failureCode: "TIMEOUT" as SubagentFailureCode,
      subagentModel: model,
      subagentUsage: totalUsage,
      subagentCostUsd: costUsd,
      subagentElapsedMs: elapsedMs,
    },
  };
}

/** 模块级惰性单例缓存：ToolExecutor 实例复用，避免每次调用重新创建 */
let _cachedToolExecutor: InstanceType<typeof import("./executor").ToolExecutor> | null = null;

/** 技能子智能体 —— 在隔离的 Flash 子智能体中执行 Skill 任务。
 *  与 handleCodeExecutorTool 不同：不要求 file_paths，使用传入的 systemPrompt，
 *  默认更多迭代（20 次），通过 ToolExecutor 支持全部工具。 */
/** 子智能体单次 API 调用的超时（毫秒），防止网络抖动导致长时间挂起 */
const SUBAGENT_API_TIMEOUT_MS = 120_000;

export async function runSkillSubagent(
  context: ToolExecutionContext,
  systemPrompt: string,
  task: string,
  model?: string,
  allowedToolNames?: string[],
  maxIters?: number,
  shouldStop?: () => boolean,
  name?: string,
): Promise<ToolExecutionResult> {
  // ── 1. 默认值 ──
  const resolvedModel = model ?? "deepseek-v4-flash";
  const resolvedMaxIters = maxIters ?? 20;
  const resultName = name ?? "SkillLoad";
  const resolvedAllowedTools = allowedToolNames ?? [
    "read_file", "grep", "glob", "gitnexus_query", "gitnexus_context",
    "gitnexus_impact", "gitnexus_clusters", "gitnexus_processes",
    "get_file_info", "directory_tree", "search_files",
    "web_search", "web_fetch", "bash",
  ];

  // ── 2. 获取 Flash client ──
  const modelInfo = context.createOpenAIClient?.(resolvedModel);
  const defaultInfo = context.createOpenAIClient?.();
  const client: OpenAI | null =
    modelInfo?.client ?? defaultInfo?.client ?? null;
  const actualModel = modelInfo?.client
    ? (modelInfo.model ?? resolvedModel)
    : (defaultInfo?.model ?? resolvedModel);
  const baseURL = modelInfo?.baseURL ?? defaultInfo?.baseURL;
  const pricing = modelInfo?.pricing ?? defaultInfo?.pricing;
  const thinkingEnabled = true;
  const reasoningEffort: "high" | "max" = "high";

  if (!client) {
    return {
      ok: false,
      name: resultName,
      error: "No API client available for skill sub-agent.",
      metadata: { failureCode: "NO_CLIENT" as SubagentFailureCode },
    };
  }

  // ── 3. 构建子智能体消息 ──
  const messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
    reasoning_content?: string;
  }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Execute the skill task: " + task },
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

  if (!_cachedToolExecutor) {
    const { ToolExecutor } = await import("./executor");
    _cachedToolExecutor = new ToolExecutor(context.projectRoot, context.createOpenAIClient);
  }
  const toolExecutor = _cachedToolExecutor;
  let noProgressStreak = 0;

  for (let iter = 0; iter < resolvedMaxIters; iter++) {
    // 用户中断检查（按 Esc 时主循环设置此标志）
    if (shouldStop?.()) {
      const elapsedMs = Date.now() - startedAt;
      const costUsd = calculateSubagentCost(totalUsage, pricing);
      return {
        ok: false,
        name: resultName,
        error: "Sub-agent interrupted by user.",
        metadata: {
          failureCode: "TIMEOUT" as SubagentFailureCode,
          subagentModel: actualModel,
          subagentUsage: totalUsage,
          subagentCostUsd: costUsd,
          subagentElapsedMs: elapsedMs,
        },
      };
    }

    // API 调用（独立 AbortController + 120s 超时，防止网络挂起）
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), SUBAGENT_API_TIMEOUT_MS);
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = (await client.chat.completions.create({
        model: actualModel,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: getSubagentTools(resolvedAllowedTools) as OpenAI.Chat.Completions.ChatCompletionTool[],
        ...thinkingOptions,
      }, {
        signal: abortController.signal,
      })) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === "AbortError") {
        const elapsedMs = Date.now() - startedAt;
        const costUsd = calculateSubagentCost(totalUsage, pricing);
        return {
          ok: false,
          name: resultName,
          error: `Skill sub-agent API call timed out after ${SUBAGENT_API_TIMEOUT_MS / 1000}s.`,
          metadata: {
            failureCode: "API_ERROR" as SubagentFailureCode,
            subagentModel: actualModel,
            subagentUsage: totalUsage,
            subagentCostUsd: costUsd,
            subagentElapsedMs: elapsedMs,
          },
        };
      }
      const costUsd = calculateSubagentCost(totalUsage, pricing);
      return {
        ok: false,
        name: resultName,
        error: `Skill sub-agent API call failed: ${msg}`,
        metadata: {
          failureCode: "API_ERROR" as SubagentFailureCode,
          subagentModel: actualModel,
          subagentUsage: totalUsage,
          subagentCostUsd: costUsd,
          subagentElapsedMs: Date.now() - startedAt,
        },
      };
    }

    clearTimeout(timeoutId);
    totalUsage = accumulateUsage(totalUsage, response.usage);

    const choice = response.choices?.[0];
    const message = choice?.message;
    const content = (message as { content?: string | null } | undefined)?.content ?? "";
    const toolCalls =
      (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? null;
    const reasoningContent =
      (message as { reasoning_content?: string } | undefined)?.reasoning_content ?? undefined;

    // 无工具调用 → 完成任务
    if (!toolCalls || toolCalls.length === 0) {
      const elapsedMs = Date.now() - startedAt;
      const costUsd = calculateSubagentCost(totalUsage, pricing);
      return {
        ok: true,
        name: resultName,
        output: JSON.stringify({
          success: true,
          output: content || "[skill sub-agent completed without output]",
          turns: iter + 1,
          tool_iters: toolIters,
          elapsed_ms: elapsedMs,
          cost_usd: Number(costUsd.toFixed(6)),
        }),
        metadata: {
          subagentModel: actualModel,
          subagentUsage: totalUsage,
          subagentCostUsd: costUsd,
          subagentElapsedMs: elapsedMs,
        },
      };
    }

    toolIters += toolCalls.length;

    // 追加 assistant 消息（含 tool calls，回传 reasoning_content）
    const assistantMsg: {
      role: "assistant";
      content: string;
      tool_calls?: unknown[];
      reasoning_content?: string;
    } = {
      role: "assistant",
      content: content ?? "",
      tool_calls: toolCalls,
    };
    if (reasoningContent) {
      assistantMsg.reasoning_content = reasoningContent;
    }
    messages.push(assistantMsg);

    // 通过 ToolExecutor 执行所有工具调用（支持全部工具）
    const toolCallResults = await toolExecutor.executeToolCalls(
      context.sessionId,
      toolCalls,
    );

    // 自适应提前终止：连续搜索但无实质性进展
    const SEARCH_TOOLS = new Set(["read_file", "grep", "glob", "search_files", "directory_tree", "get_file_info"]);
    const allSearchTools = toolCalls.length > 0 && (toolCalls as Array<{function?: {name?: string}}>).every(
      (tc) => SEARCH_TOOLS.has(tc.function?.name ?? "")
    );
    if (allSearchTools) {
      noProgressStreak++;
      if (noProgressStreak >= 3) {
        const elapsedMs = Date.now() - startedAt;
        const costUsd = calculateSubagentCost(totalUsage, pricing);
        return {
          ok: true,
          name: resultName,
          output: JSON.stringify({
            success: true,
            output: content || "[exploration stopped early — no progress after 3 search-only rounds]",
            turns: iter + 1,
            tool_iters: toolIters,
            elapsed_ms: elapsedMs,
            cost_usd: Number(costUsd.toFixed(6)),
          }),
          metadata: {
            subagentModel: actualModel,
            subagentUsage: totalUsage,
            subagentCostUsd: costUsd,
            subagentElapsedMs: elapsedMs,
          },
        };
      }
    } else {
      noProgressStreak = 0;
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = (toolCalls as Array<{ id?: string }>)[i];
      const execResult = toolCallResults[i];
      const toolContent = JSON.stringify({
        ok: execResult.result.ok,
        name: execResult.result.name,
        output: execResult.result.output,
        error: execResult.result.error,
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
    name: resultName,
    error: `Skill sub-agent exceeded maximum ${resolvedMaxIters} iterations without completing the task.`,
    metadata: {
      failureCode: "TIMEOUT" as SubagentFailureCode,
      subagentModel: actualModel,
      subagentUsage: totalUsage,
      subagentCostUsd: costUsd,
      subagentElapsedMs: elapsedMs,
    },
  };
}

/** spawn_explorer 工具 handler —— 委派 Flash Explorer 子智能体探索代码库。
 *  与 spawn_code_executor 不同：不要求 file_paths，默认使用只读+GitNexus 工具集，
 *  迭代上限 20，system prompt 为 EXPLORER_SYSTEM。 */
export async function handleSpawnExplorerTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    return {
      ok: false,
      name: "spawn_explorer",
      error: "Missing required 'task' argument.",
      metadata: { failureCode: "AMBIGUOUS" as SubagentFailureCode },
    };
  }
  const extraContext = typeof args.context === "string" ? args.context.trim() : "";
  const fullTask = extraContext ? `${task}\n\nAdditional context: ${extraContext}` : task;
  const model = typeof args.model === "string" ? args.model : undefined;
  const rawMaxIters = typeof args.max_iters === "number" ? args.max_iters as number : 20;
  const maxIters = Math.max(1, Math.min(rawMaxIters, 32));

  const EXPLORER_MIN_TOOLS = [
    "gitnexus_query", "gitnexus_context", "gitnexus_clusters",
    "gitnexus_impact", "gitnexus_processes",
    "read_file", "grep", "glob", "get_file_info", "directory_tree",
  ];

  let allowedTools: string[] | undefined;
  if (Array.isArray(args.allowed_tools)) {
    const filtered = (args.allowed_tools as string[]).filter((t) => typeof t === "string");
    if (filtered.length === 0) {
      allowedTools = undefined;
    } else {
      const hasGitNexus = filtered.some((t: string) => t.startsWith("gitnexus_"));
      const hasRead = filtered.includes("read_file");
      if (!hasGitNexus || !hasRead) {
        allowedTools = [...new Set([...filtered, ...EXPLORER_MIN_TOOLS])];
      } else {
        allowedTools = filtered;
      }
    }
  }

  // Explorer is read-only — strip any write tools passed by the parent
  const WRITE_TOOLS = new Set(["edit_file", "write_file", "multi_edit", "bash"]);
  if (allowedTools) {
    allowedTools = allowedTools.filter((t) => !WRITE_TOOLS.has(t));
  }

  return await runSkillSubagent(
    context,
    EXPLORER_SYSTEM,
    fullTask,
    model,
    allowedTools,
    maxIters,
    context.shouldStop,
    "spawn_explorer",
  );
}
