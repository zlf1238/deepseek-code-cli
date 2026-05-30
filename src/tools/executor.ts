import type OpenAI from "openai";
import type { ReasoningEffort, ResolvedAutoSwitchConfig } from "../settings";
import type { PricingSnapshot } from "../model-capabilities";
import { handleAskUserQuestionTool } from "./ask-user-question-handler";
import { handleBashTool } from "./bash-handler";
import { handleEditTool } from "./edit-handler";
import { handleGlobTool } from "./glob-handler";
import { handleGrepTool } from "./grep-handler";
import { handleReadTool } from "./read-handler";
import { handleWebSearchTool } from "./web-search-handler";
import { handleWriteTool } from "./write-handler";
import { handleSkillLoadTool } from "./skill-load-handler";
import { handleDirectoryTreeTool } from "./directory-tree-handler";
import { handleMultiEditTool } from "./multi-edit-handler";
import { handleTodoWriteTool } from "./todo-write-handler";
import { handleWebFetchTool } from "./web-fetch-handler";
import { handleRunBackgroundTool, handleJobOutputTool, handleListJobsTool, handleStopJobTool } from "./background-job-handler";
import { handleGetFileInfoTool } from "./get-file-info-handler";
import { handleHandleReadTool } from "./handle-read-handler";
import { handleRetrieveToolResultTool } from "./retrieve-tool-result-handler";

import {
  handleGitnexusQuery,
  handleGitnexusContext,
  handleGitnexusImpact,
  handleGitnexusDetectChanges,
  handleGitnexusRename,
  handleGitnexusClusters,
  handleGitnexusProcesses,
} from "./gitnexus-handler";

export type CreateOpenAIClient = (overrideModel?: string) => {
  client: OpenAI | null;
  model: string;
  baseURL?: string;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  notify?: string;
  webSearchTool?: string;
  machineId?: string;
  /** Per-model pricing snapshot (per million tokens). */
  pricing?: PricingSnapshot;
  /** Auto-switch configuration. */
  autoSwitch?: ResolvedAutoSwitchConfig;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolExecutionContext = {
  sessionId: string;
  projectRoot: string;
  toolCall: ToolCall;
  createOpenAIClient?: CreateOpenAIClient;
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  /** 用户中断信号 —— 子智能体循环应定期检查此回调 */
  shouldStop?: () => boolean;
};

export type ToolExecutionHooks = {
  onProcessStart?: (processId: string | number, command: string) => void;
  onProcessExit?: (processId: string | number) => void;
  shouldStop?: () => boolean;
};

export type ToolExecutionResult = {
  ok: boolean;
  name: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  awaitUserResponse?: boolean;
  followUpMessages?: ToolExecutionFollowUpMessage[];
};

export type ToolExecutionFollowUpMessage = {
  role: "system";
  content: string;
  contentParams?: unknown | null;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolExecutionResult>;

export type ToolCallExecution = {
  toolCallId: string;
  content: string;
  result: ToolExecutionResult;
};

export class ToolExecutor {
  private readonly projectRoot: string;
  private readonly createOpenAIClient?: CreateOpenAIClient;
  private readonly toolHandlers = new Map<string, ToolHandler>();

  constructor(projectRoot: string, createOpenAIClient?: CreateOpenAIClient) {
    this.projectRoot = projectRoot;
    this.createOpenAIClient = createOpenAIClient;
    this.registerToolHandlers();
  }

  /** 借鉴 Reasonix: 只读工具可并行安全执行。写入/交互工具必须串行。 */
  private static readonly PARALLEL_SAFE_TOOLS = new Set([
    "read", "glob", "grep", "directory_tree",
    "get_file_info", "web_fetch", "WebSearch", "SkillLoad",
    "list_jobs", "job_output",
    "handle_read", "retrieve_tool_result",
    "gitnexus_query", "gitnexus_context", "gitnexus_impact",
    "gitnexus_detect_changes", "gitnexus_rename",
    "gitnexus_clusters", "gitnexus_processes",
  ]);

  /** 借鉴 Reasonix: 并行最大分块数。可通过 REASONIX_PARALLEL_MAX 环境变量覆写。 */
  private static readonly PARALLEL_MAX =
    Math.min(Number.parseInt(process.env.REASONIX_PARALLEL_MAX ?? "3", 10) || 3, 16);

  private isParallelSafe(name: string): boolean {
    return ToolExecutor.PARALLEL_SAFE_TOOLS.has(name);
  }

  async executeToolCalls(
    sessionId: string,
    toolCalls: unknown[],
    hooks?: ToolExecutionHooks
  ): Promise<ToolCallExecution[]> {
    const parsedCalls = toolCalls
      .map((toolCall) => this.parseToolCall(toolCall))
      .filter((toolCall): toolCall is ToolCall => Boolean(toolCall));

    const executions: ToolCallExecution[] = [];
    let callIdx = 0;

    while (callIdx < parsedCalls.length) {
      if (hooks?.shouldStop?.()) break;

      // 借鉴 Reasonix: 将连续的可并行工具调用分组
      const chunk: ToolCall[] = [];
      while (
        callIdx < parsedCalls.length &&
        chunk.length < ToolExecutor.PARALLEL_MAX &&
        this.isParallelSafe(parsedCalls[callIdx]!.function.name)
      ) {
        chunk.push(parsedCalls[callIdx++]!);
      }

      // 不可并行的工具单独成组（串行屏障）
      if (chunk.length === 0) {
        chunk.push(parsedCalls[callIdx++]!);
      }

      // 并行执行分块: Promise.allSettled 竞争, 结果按声明顺序收集
      if (chunk.length > 1) {
        const settled = await Promise.allSettled(
          chunk.map((c) => this.executeToolCall(sessionId, c, hooks)),
        );
        for (let k = 0; k < chunk.length; k++) {
          const call = chunk[k]!;
          const s = settled[k]!;
          const result: ToolExecutionResult =
            s.status === "fulfilled"
              ? s.value
              : { ok: false, name: call.function.name, error: String(s.reason) };
          executions.push({
            toolCallId: call.id,
            content: this.formatToolResult(result, call.id),
            result,
          });
        }
      } else {
        const call = chunk[0]!;
        const result = await this.executeToolCall(sessionId, call, hooks);
        executions.push({
          toolCallId: call.id,
          content: this.formatToolResult(result, call.id),
          result,
        });
      }

      if (hooks?.shouldStop?.()) break;
    }

    return executions;
  }

  private registerToolHandlers(): void {
    this.toolHandlers.set("bash", handleBashTool);
    this.toolHandlers.set("read", handleReadTool);
    this.toolHandlers.set("write", handleWriteTool);
    this.toolHandlers.set("edit", handleEditTool);
    this.toolHandlers.set("glob", handleGlobTool);
    this.toolHandlers.set("grep", handleGrepTool);
    this.toolHandlers.set("AskUserQuestion", handleAskUserQuestionTool);
    this.toolHandlers.set("WebSearch", handleWebSearchTool);
    this.toolHandlers.set("SkillLoad", handleSkillLoadTool);
    this.toolHandlers.set("directory_tree", handleDirectoryTreeTool);
    this.toolHandlers.set("multi_edit", handleMultiEditTool);
    this.toolHandlers.set("todo_write", handleTodoWriteTool);
    this.toolHandlers.set("web_fetch", handleWebFetchTool);
    this.toolHandlers.set("run_background", handleRunBackgroundTool);
    this.toolHandlers.set("job_output", handleJobOutputTool);
    this.toolHandlers.set("list_jobs", handleListJobsTool);
    // ask_choice 委托到 AskUserQuestion 实现（共享同一 UI 基础设施）
    this.toolHandlers.set("ask_choice", async (args, context) => {
      // 将扁平参数转换为 AskUserQuestion 的嵌套格式
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) {
        return { ok: false, name: "ask_choice", error: 'Missing required "question" string.' };
      }

      const rawOptions = args.options;
      if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        return { ok: false, name: "ask_choice", error: '"options" must be a non-empty array.' };
      }

      if (rawOptions.length > 6) {
        return { ok: false, name: "ask_choice", error: "Maximum 6 options allowed." };
      }

      const options: Array<{ label: string; description?: string }> = [];
      for (let i = 0; i < rawOptions.length; i++) {
        const opt = rawOptions[i];
        if (!opt || typeof opt !== "object") {
          return { ok: false, name: "ask_choice", error: `Option at index ${i} must be an object.` };
        }
        const label = typeof (opt as Record<string, unknown>).label === "string"
          ? (opt as Record<string, unknown>).label as string
          : "";
        if (!label.trim()) {
          return { ok: false, name: "ask_choice", error: `Option at index ${i} missing "label".` };
        }
        options.push({
          label: label.trim(),
          description: typeof (opt as Record<string, unknown>).description === "string"
            ? (opt as Record<string, unknown>).description as string
            : undefined,
        });
      }

      const convertedArgs: Record<string, unknown> = {
        questions: [{
          question,
          options,
          multiSelect: args.multiSelect === true ? true : undefined,
        }],
      };

      const result = await handleAskUserQuestionTool(convertedArgs, context);

      // 重写 name 和 metadata.kind 以保持 ask_choice 兼容性
      return {
        ...result,
        name: "ask_choice",
        metadata: {
          kind: "ask_choice",
          question,
          options,
          multiSelect: args.multiSelect === true,
          allowCustom: args.allowCustom !== false,
        },
      };
    });
    this.toolHandlers.set("get_file_info", handleGetFileInfoTool);
    this.toolHandlers.set("stop_job", handleStopJobTool);
    this.toolHandlers.set("handle_read", handleHandleReadTool);
    this.toolHandlers.set("retrieve_tool_result", handleRetrieveToolResultTool);
    this.toolHandlers.set("gitnexus_query", handleGitnexusQuery);
    this.toolHandlers.set("gitnexus_context", handleGitnexusContext);
    this.toolHandlers.set("gitnexus_impact", handleGitnexusImpact);
    this.toolHandlers.set("gitnexus_detect_changes", handleGitnexusDetectChanges);
    this.toolHandlers.set("gitnexus_rename", handleGitnexusRename);
    this.toolHandlers.set("gitnexus_clusters", handleGitnexusClusters);
    this.toolHandlers.set("gitnexus_processes", handleGitnexusProcesses);
  }

  private parseToolCall(toolCall: unknown): ToolCall | null {
    if (!toolCall || typeof toolCall !== "object") {
      return null;
    }

    const record = toolCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };

    if (typeof record.id !== "string") {
      return null;
    }

    const functionRecord = record.function;
    if (!functionRecord || typeof functionRecord !== "object") {
      return null;
    }

    if (typeof functionRecord.name !== "string") {
      return null;
    }

    const rawArguments =
      typeof functionRecord.arguments === "string" ? functionRecord.arguments : "";

    return {
      id: record.id,
      type: "function",
      function: {
        name: functionRecord.name,
        arguments: rawArguments
      }
    };
  }

  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    hooks?: ToolExecutionHooks
  ): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name;
    const handler = this.toolHandlers.get(toolName);
    if (!handler) {
      return {
        ok: false,
        name: toolName,
        error: `Unknown tool: ${toolName}`
      };
    }

    const parsedArgs = this.parseToolArguments(toolCall.function.arguments);
    if (!parsedArgs.ok) {
      return {
        ok: false,
        name: toolName,
        error: parsedArgs.error
      };
    }

    try {
      return await handler(parsedArgs.args, {
        sessionId,
        projectRoot: this.projectRoot,
        toolCall,
        createOpenAIClient: this.createOpenAIClient,
        onProcessStart: hooks?.onProcessStart,
        onProcessExit: hooks?.onProcessExit,
        shouldStop: hooks?.shouldStop
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        name: toolName,
        error: message
      };
    }
  }

  private parseToolArguments(
    rawArguments: string
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!rawArguments) {
      return { ok: true, args: {} };
    }

    try {
      const parsed = JSON.parse(rawArguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "InputParseError: Tool arguments must be a JSON object." };
      }
      return { ok: true, args: parsed as Record<string, unknown> };
    } catch {
      // 借鉴 Reasonix Pillar-2 truncation pass: 尝试本地修复截断的 JSON
      try {
        const { repairTruncatedJson } = require("../repair/truncation");
        const result = repairTruncatedJson(rawArguments);
        if (result.changed) {
          const parsed = JSON.parse(result.repaired);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { ok: true, args: parsed as Record<string, unknown> };
          }
        }
      } catch { /* repair failed */ }
    }

    return {
      ok: false,
      error:
        "InputParseError: Failed to parse tool arguments as JSON. " +
        "Ensure the tool call arguments are valid JSON. Prefer Edit over Write for large existing-file changes.",
    };
  }

  private formatToolResult(result: ToolExecutionResult, toolCallId?: string): string {
    const payload: Record<string, unknown> = {
      ok: result.ok,
      name: result.name
    };

    if (toolCallId) {
      payload.tool_call_id = toolCallId;
    }

    if (typeof result.output !== "undefined") {
      payload.output = result.output;
    }

    if (result.error) {
      payload.error = result.error;
    }

    if (result.metadata && Object.keys(result.metadata).length > 0) {
      payload.metadata = { ...result.metadata };
      if (toolCallId && !(payload.metadata as Record<string, unknown>).tool_call_id) {
        (payload.metadata as Record<string, unknown>).tool_call_id = toolCallId;
      }
    } else if (toolCallId) {
      payload.metadata = { tool_call_id: toolCallId };
    }

    if (result.awaitUserResponse === true) {
      payload.awaitUserResponse = true;
    }

    return JSON.stringify(payload, null, 2);
  }

}
