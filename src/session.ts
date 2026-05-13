import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import matter from "gray-matter";
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from "openai/resources/chat/completions";
import { launchNotifyScript } from "./notify";
import { buildThinkingRequestOptions } from "./openai-thinking";
import { getContextWindowCapacity, selectModelForIteration, selectModelByPrice, DEEPSEEK_V4_FLASH } from "./model-capabilities";
import type { PricingSnapshot, SwitchContext } from "./model-capabilities";
import { getCompactPrompt, getSystemPrompt, getTools } from "./prompt";
import { ToolExecutor, type CreateOpenAIClient } from "./tools/executor";

const MAX_SESSION_ENTRIES = 50;
const COMPACT_PROMPT_TOKEN_RATIO = 0.8;

export function getCompactPromptTokenThreshold(model: string): number {
  return Math.round(getContextWindowCapacity(model) * COMPACT_PROMPT_TOKEN_RATIO);
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }

  if (isUsageRecord(next)) {
    const currentRecord = isUsageRecord(current) ? current : {};
    const result: Record<string, unknown> = { ...currentRecord };
    for (const [key, value] of Object.entries(next)) {
      result[key] = addUsageValue(currentRecord[key], value);
    }
    return result;
  }

  return next;
}

function accumulateUsage(current: unknown | null, next: unknown | null | undefined): unknown | null {
  if (next == null) {
    return current ?? null;
  }
  return addUsageValue(current, next);
}

export function getTotalTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = usage.total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

export function getPromptTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const promptTokens = usage.prompt_tokens;
  return typeof promptTokens === "number" ? promptTokens : 0;
}

export function getCompletionTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const completionTokens = usage.completion_tokens;
  return typeof completionTokens === "number" ? completionTokens : 0;
}

export function getPromptCacheHitTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const cacheHit = usage.prompt_cache_hit_tokens;
  return typeof cacheHit === "number" ? cacheHit : 0;
}

export function getPromptCacheMissTokens(usage: unknown | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const cacheMiss = usage.prompt_cache_miss_tokens;
  return typeof cacheMiss === "number" ? cacheMiss : 0;
}

export function getCacheHitRate(usage: unknown | null | undefined): number {
  const hit = getPromptCacheHitTokens(usage);
  const miss = getPromptCacheMissTokens(usage);
  const total = hit + miss;
  if (total === 0) return 0;
  return hit / total;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export type SessionStatus =
  | "failed"
  | "pending"
  | "processing"
  | "waiting_for_user"
  | "completed"
  | "interrupted";

export type SessionEntry = {
  id: string;
  summary: string | null;
  assistantReply: string | null;
  assistantThinking: string | null;
  assistantRefusal: string | null;
  toolCalls: unknown[] | null;
  status: SessionStatus;
  failReason: string | null;
  usage: unknown | null;
  /** 按模型名拆分的 usage 累计数据，用于区分不同模型的 token 消耗和费用 */
  usageByModel?: Record<string, unknown>;
  activeTokens: number;
  compactThreshold: number;
  createTime: string;
  updateTime: string;
  processes: Map<string, { startTime: string; command: string }> | null;  // {pid: {startTime, command}}
};

export type SessionsIndex = {
  version: 1;
  entries: SessionEntry[];
  originalPath: string;
};

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export type MessageMeta = {
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  asThinking?: boolean;
  isSummary?: boolean;
  skill?: SkillInfo;
  /** 步骤指示器，在隐藏工具执行结果时显示精简步骤描述 */
  isStepIndicator?: boolean;
  stepDescription?: string;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string | null;
  contentParams: unknown | null;
  messageParams: unknown | null;
  compacted: boolean;
  visible: boolean;
  createTime: string;
  updateTime: string;
  meta?: MessageMeta;
  html?: string;
};

export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
};

type SessionManagerOptions = {
  projectRoot: string;
  createOpenAIClient: CreateOpenAIClient;
  getResolvedSettings: () => { webSearchTool?: string };
  renderMarkdown: (text: string) => string;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  phase: "start" | "update" | "end";
};

export class SessionManager {
  private readonly projectRoot: string;
  private readonly createOpenAIClient: CreateOpenAIClient;
  private readonly getResolvedSettings: () => { webSearchTool?: string };
  private readonly onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  private readonly onSessionEntryUpdated?: (entry: SessionEntry) => void;
  private readonly onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  private activeSessionId: string | null = null;
  private activePromptController: AbortController | null = null;
  private readonly sessionControllers = new Map<string, AbortController>();
  private readonly toolExecutor: ToolExecutor;

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.createOpenAIClient = options.createOpenAIClient;
    this.getResolvedSettings = options.getResolvedSettings;
    this.onAssistantMessage = options.onAssistantMessage;
    this.onSessionEntryUpdated = options.onSessionEntryUpdated;
    this.onLlmStreamProgress = options.onLlmStreamProgress;
    this.toolExecutor = new ToolExecutor(this.projectRoot, this.createOpenAIClient);
  }

  private estimateStreamTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      tokens += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 0.6 : 0.3;
    }
    return tokens;
  }

  /** 从一批工具调用中提取最后一个工具调用的函数名称。 */
  private extractLastToolName(toolCalls: unknown[]): string | undefined {
    if (toolCalls.length === 0) return undefined;
    const last = toolCalls[toolCalls.length - 1];
    if (
      typeof last === "object" &&
      last !== null &&
      !Array.isArray(last)
    ) {
      const fn = (last as Record<string, unknown>).function;
      if (
        typeof fn === "object" &&
        fn !== null &&
        !Array.isArray(fn)
      ) {
        const name = (fn as Record<string, unknown>).name;
        return typeof name === "string" ? name : undefined;
      }
    }
    return undefined;
  }

  private formatEstimatedTokens(tokens: number): string {
    if (tokens <= 0) {
      return "0";
    }

    const roundedTokens = Math.round(tokens);
    if (roundedTokens <= 0) {
      return "0";
    }

    if (roundedTokens < 100) {
      return String(roundedTokens);
    }

    if (roundedTokens < 10000) {
      return `${Number((roundedTokens / 1000).toFixed(1))}k`;
    }

    return `${Math.round(roundedTokens / 1000)}k`;
  }

  private emitLlmStreamProgress(
    requestId: string,
    startedAt: string,
    estimatedTokens: number,
    phase: LlmStreamProgress["phase"],
    sessionId?: string
  ): void {
    this.onLlmStreamProgress?.({
      requestId,
      sessionId,
      startedAt,
      estimatedTokens: Math.round(estimatedTokens),
      formattedTokens: this.formatEstimatedTokens(estimatedTokens),
      phase
    });
  }

  private isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "AbortError" || error.constructor.name === "APIUserAbortError";
  }

  private throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Request was aborted.");
    error.name = "AbortError";
    throw error;
  }

  private async createChatCompletionStream(
    client: NonNullable<ReturnType<CreateOpenAIClient>["client"]>,
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
    sessionId?: string
  ): Promise<{
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: unknown;
  }> {
    const requestId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let estimatedTokens = 0;
    this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "start", sessionId);

    const streamRequest = {
      ...request,
      stream: true,
      stream_options: {
        ...(isUsageRecord(request.stream_options) ? request.stream_options : {}),
        include_usage: true
      }
    };

    let response: unknown;
    try {
      response = await (client.chat.completions.create as unknown as (
        body: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => Promise<unknown>)(streamRequest, options);
    } catch (error) {
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      throw error;
    }

    if (!response || typeof (response as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      return response as { choices?: Array<{ message?: Record<string, unknown> }>; usage?: unknown };
    }

    let content = "";
    let reasoningContent = "";
    let refusal: string | null = null;
    let usage: unknown = null;
    const toolCallsByIndex = new Map<number, {
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>();

    const trackText = (value: unknown) => {
      if (typeof value !== "string" || value.length === 0) {
        return;
      }
      estimatedTokens += this.estimateStreamTokens(value);
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "update", sessionId);
    };

    try {
      for await (const chunk of response as AsyncIterable<Record<string, unknown>>) {
        if ("usage" in chunk && chunk.usage != null) {
          usage = chunk.usage;
        }

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
          const delta = isUsageRecord(choice) && isUsageRecord(choice.delta) ? choice.delta : null;
          if (!delta) {
            continue;
          }

          const contentDelta = delta.content;
          if (typeof contentDelta === "string") {
            content += contentDelta;
            trackText(contentDelta);
          }

          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningDelta === "string") {
            reasoningContent += reasoningDelta;
            trackText(reasoningDelta);
          }

          if (typeof delta.refusal === "string") {
            refusal = `${refusal ?? ""}${delta.refusal}`;
            trackText(delta.refusal);
          }

          const rawToolCalls = delta.tool_calls;
          if (Array.isArray(rawToolCalls)) {
            for (const rawToolCall of rawToolCalls) {
              if (!isUsageRecord(rawToolCall)) {
                continue;
              }
              const index = typeof rawToolCall.index === "number" ? rawToolCall.index : toolCallsByIndex.size;
              const current = toolCallsByIndex.get(index) ?? {};
              if (typeof rawToolCall.id === "string") {
                current.id = rawToolCall.id;
              }
              if (typeof rawToolCall.type === "string") {
                current.type = rawToolCall.type;
              }
              const rawFunction = isUsageRecord(rawToolCall.function) ? rawToolCall.function : null;
              if (rawFunction) {
                current.function = current.function ?? {};
                if (typeof rawFunction.name === "string") {
                  current.function.name = `${current.function.name ?? ""}${rawFunction.name}`;
                  trackText(rawFunction.name);
                }
                if (typeof rawFunction.arguments === "string") {
                  current.function.arguments = `${current.function.arguments ?? ""}${rawFunction.arguments}`;
                  trackText(rawFunction.arguments);
                }
              }
              toolCallsByIndex.set(index, current);
            }
          }
        }
      }
    } finally {
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    const message: Record<string, unknown> = { content };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    if (reasoningContent.length > 0) {
      message.reasoning_content = reasoningContent;
    }
    if (refusal != null) {
      message.refusal = refusal;
    }

    return {
      choices: [{ message }],
      usage
    };
  }

  async identifyMatchingSkillNames(
    skills: SkillInfo[],
    userPrompt: string,
    options?: { signal?: AbortSignal; sessionId?: string }
  ): Promise<string[]> {
    this.throwIfAborted(options?.signal);
    let systemPrompt = `When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n
Response in JSON format:
\`\`\`
{
  "skillNames": ["", ...]
}
\`\`\`\n
If none of the available skills match, respond with an empty array, i.e. \`{"skillNames": []}\`.\n
The candidate skills are as follows:\n\n`;
    const simpleSkills = skills.filter((x) => !x.isLoaded).map((x) => {
      return {name: x.name, description: x.description};
    })
    if (simpleSkills.length === 0) {
      return [];
    }
    systemPrompt += "```\n" + JSON.stringify(simpleSkills, null, 2) + "\n```";
    
    const { client, model } = this.createOpenAIClient();
    if (!client) {
      return [];
    }

    try {
      const response = await this.createChatCompletionStream(client, {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" }
      }, options?.signal ? { signal: options.signal } : undefined, options?.sessionId);
      this.throwIfAborted(options?.signal);
      
      const rawContent = response.choices?.[0]?.message?.content;
      const content = typeof rawContent === "string" ? rawContent : "";
      if (!content) {
        return [];
      }

      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.skillNames)) {
        return parsed.skillNames;
      }
      
      return [];
    } catch (error) {
      if (this.isAbortLikeError(error) || options?.signal?.aborted) {
        throw error;
      }
      return [];
    }
  }

  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    const homeDir = os.homedir();
    const agentsRoot = path.join(homeDir, ".agents", "skills");
    const projectSkillsRoot = path.join(this.projectRoot, ".deepseek-code", "skills");
    const skillsByName = new Map<string, SkillInfo>();

    const collectSkills = (root: string, displayRoot: string): SkillInfo[] => {
      if (!fs.existsSync(root)) {
        return [];
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }

      const results: SkillInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const skillName = entry.name;
        const skillPath = path.join(root, skillName, "SKILL.md");
        try {
          if (!fs.existsSync(skillPath)) {
            continue;
          }
          const stat = fs.statSync(skillPath);
          if (!stat.isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        results.push(this.readSkillInfo(skillPath, `${displayRoot}/${skillName}/SKILL.md`, skillName));
      }
      return results;
    };

    for (const skill of collectSkills(agentsRoot, "~/.agents/skills")) {
      skillsByName.set(skill.name, skill);
    }
    for (const skill of collectSkills(projectSkillsRoot, "./.deepseek-code/skills")) {
      skillsByName.set(skill.name, skill);
    }

    if (sessionId) {
      const loadedSkillKeys = this.getLoadedSkillKeys(sessionId);
      for (const skill of skillsByName.values()) {
        if (
          loadedSkillKeys.has(this.getSkillKey(skill))
          || loadedSkillKeys.has(this.getSkillKeyByName(skill.name))
        ) {
          skill.isLoaded = true;
        }
      }
    }

    return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveSkillPath(skillPath: string): string {
    if (skillPath.startsWith("~/")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("~\\")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("./")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (skillPath.startsWith(".\\")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (path.isAbsolute(skillPath)) {
      return skillPath;
    }
    return path.join(os.homedir(), skillPath);
  }

  private readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    const fallbackSkill: SkillInfo = {
      name: fallbackName.replace(/_/g, "-"),
      path: displayPath,
      description: "",
    };

    try {
      const skillMd = fs.readFileSync(skillPath, "utf8");
      const parsed = matter(skillMd);
      return {
        name:
          typeof parsed.data.name === "string" && parsed.data.name.trim()
            ? parsed.data.name.trim()
            : fallbackSkill.name,
        path: displayPath,
        description:
          typeof parsed.data.description === "string"
            ? parsed.data.description.trim()
            : "",
      };
    } catch {
      return fallbackSkill;
    }
  }

  private getSkillKey(skill: Pick<SkillInfo, "path">): string {
    return `path:${skill.path}`;
  }

  private getSkillKeyByName(name: string): string {
    return `name:${name}`;
  }

  private getLoadedSkillKeys(sessionId: string): Set<string> {
    const loadedSkillKeys = new Set<string>();
    for (const message of this.listSessionMessages(sessionId)) {
      if (message.role !== "system" || !message.meta?.skill) {
        continue;
      }
      loadedSkillKeys.add(this.getSkillKey(message.meta.skill));
      loadedSkillKeys.add(this.getSkillKeyByName(message.meta.skill.name));
    }
    return loadedSkillKeys;
  }

  private dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
    if (!skills || skills.length === 0) {
      return undefined;
    }

    const dedupedSkills = new Map<string, SkillInfo>();
    for (const skill of skills) {
      if (!skill?.name || !skill?.path) {
        continue;
      }
      const key = this.getSkillKey(skill);
      const existingSkill = dedupedSkills.get(key);
      dedupedSkills.set(key, {
        ...existingSkill,
        ...skill,
        description: skill.description ?? existingSkill?.description ?? "",
        isLoaded: Boolean(existingSkill?.isLoaded || skill.isLoaded),
      });
    }

    return Array.from(dedupedSkills.values());
  }

  private async normalizeSkills(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    const dedupedSkills = this.dedupeSkills(skills);
    if (!dedupedSkills || dedupedSkills.length === 0) {
      return undefined;
    }

    const availableSkills = await this.listSkills(sessionId);
    const availableSkillsByKey = new Map<string, SkillInfo>();
    for (const skill of availableSkills) {
      availableSkillsByKey.set(this.getSkillKey(skill), skill);
      availableSkillsByKey.set(this.getSkillKeyByName(skill.name), skill);
    }

    return dedupedSkills.map((skill) => {
      const matchedSkill =
        availableSkillsByKey.get(this.getSkillKey(skill))
        ?? availableSkillsByKey.get(this.getSkillKeyByName(skill.name));
      if (!matchedSkill) {
        return skill;
      }
      return {
        ...matchedSkill,
        ...skill,
        description: matchedSkill.description || skill.description,
        isLoaded: Boolean(matchedSkill.isLoaded || skill.isLoaded),
      };
    });
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  async handleUserPrompt(userPrompt: UserPromptContent): Promise<void> {
    const controller = new AbortController();
    this.activePromptController = controller;

    try {
      if (!this.activeSessionId || !this.getSession(this.activeSessionId)) {
        await this.createSession(userPrompt, controller);
      } else {
        await this.replySession(this.activeSessionId, userPrompt, controller);
      }
    } catch (error) {
      if (!this.isAbortLikeError(error) && !controller.signal.aborted) {
        throw error;
      }
    } finally {
      if (this.activePromptController === controller) {
        this.activePromptController = null;
      }
    }
  }

  async createSession(userPrompt: UserPromptContent, controller?: AbortController): Promise<string> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    // Skill matching is now handled by the model reading Available Skills index
    // in the system prompt and calling SkillLoad when needed.
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const index = this.loadSessionsIndex();
    const entry: SessionEntry = {
      id: sessionId,
      summary: userPrompt.text ? userPrompt.text.slice(0, 100) : "[Image Prompt]",
      assistantReply: null,
      assistantThinking: null,
      assistantRefusal: null,
      toolCalls: null,
      status: "pending",
      failReason: null,
      usage: null,
      activeTokens: 0,
      compactThreshold: 0,
      createTime: now,
      updateTime: now,
      processes: null
    };
    index.entries.push(entry);
    const sortedEntries = index.entries
      .slice()
      .sort((a, b) => {
        const aTime = Date.parse(a.updateTime);
        const bTime = Date.parse(b.updateTime);
        if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
          return b.updateTime.localeCompare(a.updateTime);
        }
        return bTime - aTime;
      });
    const keptEntries = sortedEntries.slice(0, MAX_SESSION_ENTRIES);
    const keptIds = new Set(keptEntries.map((item) => item.id));
    const droppedEntries = sortedEntries.filter((item) => !keptIds.has(item.id));
    index.entries = keptEntries;
    this.saveSessionsIndex(index);
    this.removeSessionMessages(droppedEntries.map((item) => item.id));

    // 提前获取主模型，用于选择对应模型优化的系统提示词
    const primaryModel = this.createOpenAIClient().model;
    let systemPrompt = getSystemPrompt(this.projectRoot, this.getPromptToolOptions());

    // AGENTS.md / REASONIX.md 烘焙进 system prompt 字符串，而非独立 system 消息。
    // 借鉴 Reasonix: project memory 是前缀的原子组成部分，确保一条消息发给 API。
    const agentInstructions = this.loadAgentInstructions();
    if (agentInstructions) {
      systemPrompt = `${systemPrompt}\n\n# Project Instructions\n\n${agentInstructions}`;
    }

    const systemMessage = this.buildSystemMessage(sessionId, systemPrompt);
    this.appendSessionMessage(sessionId, systemMessage);

    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // Skills are now loaded on-demand via the SkillLoad tool (see tools/executor.ts).
    // The skills index is already embedded in the system prompt via getSkillsIndex().

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
    return sessionId;
  }

  async replySession(sessionId: string, userPrompt: UserPromptContent, controller?: AbortController): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);
    const now = new Date().toISOString();
    const updated = this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "pending",
      failReason: null,
      updateTime: now
    }));

    if (!updated) {
      await this.createSession(userPrompt, controller);
      return;
    }

    this.closePendingToolCalls(sessionId, "Previous tool call did not complete.");

    // Skill matching is now handled by the model reading Available Skills index
    // in the system prompt and calling SkillLoad when needed.

    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
  }

  /** 驱动 LLM 主交互循环：发送消息、执行工具调用、压缩上下文、更新会话状态。 */
  async activateSession(sessionId: string, controller?: AbortController): Promise<void> {
    const startedAt = Date.now();
    const primary = this.createOpenAIClient();
    const primaryModel = primary.model;
    const notify = primary.notify;
    const now = new Date().toISOString();

    if (!primary.client) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "OpenAI API key not found",
        updateTime: now
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(sessionId, "OpenAI API key not found. Please configure ~/.deepseek-code/settings.json.", null),
        false,
      );
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt);
      return;
    }

    const sessionController = controller ?? new AbortController();
    if (sessionController.signal.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "interrupted",
        failReason: "interrupted",
        updateTime: now
      }));
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt);
      return;
    }

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      updateTime: now
    }));

    this.sessionControllers.set(sessionId, sessionController);
    this.closePendingToolCalls(sessionId, "Previous tool call did not complete.");

    try {
      const maxIterations = 80000;  // 约 1000 元成本上限
      let toolCalls: unknown[] | null = null;
      let lastToolName: string | undefined;
      let currentClient = primary.client;
      let currentModel = primaryModel;
      let currentThinkingEnabled = primary.thinkingEnabled;
      let currentBaseURL = primary.baseURL;
      let currentReasoningEffort = primary.reasoningEffort;
      let wasAutoSwitched = false;  // pro→flash 自动切换标记

      // ── 双向切换状态追踪 ──
      let roundsOnFlash = 0;           // Flash 连续运行轮数
      let newUserMessage = true;       // 第一轮/用户新消息标记
      const uniqueTools = new Set<string>();  // 本会话使用过的工具类型
      let toolErrors = 0;             // 工具调用失败次数
      let toolTotal = 0;              // 工具调用总次数

      // 预获取两个模型的定价信息（用于价格感知切换）
      const proPricing = primary.pricing;
      const flashClientInfo = this.createOpenAIClient("deepseek-v4-flash");
      const flashPricing = flashClientInfo.pricing;
      const autoSwitch = primary.autoSwitch;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.isInterrupted(sessionId)) {
          return;
        }

        // 获取价格感知切换所需的累积 token 数
        // 同时包含历史 usage 和本轮已处理的 input tokens
        const sessionEntry = this.getSession(sessionId);
        // 历史累积 usage 已包含所有已完成轮次的 token，无需额外加上 activeTokens（否则会重复计数最近一轮）
        const accumulatedTokens = sessionEntry
          ? getTotalTokens(sessionEntry.usage)
          : 0;

        // 当定价信息可用时，使用价格感知算法选择模型
        let selectedModel: string;
        let switchReason: string;
        if (proPricing && flashPricing && primaryModel === "deepseek-v4-pro") {
          const switchCtx: SwitchContext = {
            enabled: autoSwitch?.enabled ?? true,
            proPricing,
            flashPricing,
            accumulatedTokens,
            lastToolName,
            maxPaybackRounds: autoSwitch?.maxPaybackRounds ?? 8,
            estimatedOutputPerRound: autoSwitch?.estimatedOutputPerRound ?? 8000,
            estimatedInputPerRound: autoSwitch?.estimatedInputPerRound ?? 500,
            cacheHitRate: autoSwitch?.cacheHitRate ?? 0.5,
            currentModel,
            roundsOnFlash,
            errorRate: toolTotal > 0 ? toolErrors / toolTotal : undefined,
            uniqueToolCount: uniqueTools.size > 0 ? uniqueTools.size : undefined,
            newUserMessage,
          };
          const result = selectModelByPrice(primaryModel, toolCalls !== null, switchCtx);
          selectedModel = result.model;
          switchReason = result.reason;
        } else {
          selectedModel = selectModelForIteration(primaryModel, toolCalls !== null);
          switchReason = selectedModel === currentModel ? "keep" : "switch";
        }

        if (selectedModel !== currentModel) {
          const next = this.createOpenAIClient(selectedModel);
          if (next.client) {
            currentClient = next.client;
            currentModel = next.model;
            // 自动切换到 Flash 时强制开启深度思考，确保编程质量
            currentThinkingEnabled = selectedModel === "deepseek-v4-flash" ? true : next.thinkingEnabled;
            currentBaseURL = next.baseURL ?? primary.baseURL;
            currentReasoningEffort = next.reasoningEffort ?? primary.reasoningEffort;

            // 模型切换是客户端行为，不注入 API 可见消息以免截断缓存前缀。
            // 借鉴 Reasonix: 切换仅改变 client 变量，对 API 完全透明。
            this.onAssistantMessage(
              this.buildAssistantMessage(
                sessionId,
                `[模型切换] ${switchReason}`,
                null
              ),
              false
            );
            wasAutoSwitched = true;
          }
          // 若 next client 为 null（如未配置 flash），保持当前模型
        }

        const session = this.getSession(sessionId);
        if (session == null || session.status === "interrupted" || session.status === "failed") {
          return;
        }

        const compactPromptTokenThreshold = getCompactPromptTokenThreshold(currentModel);

        // 将阈值存储到 session entry，以便 UI 显示容量使用情况
        if (session.compactThreshold !== compactPromptTokenThreshold) {
          this.updateSessionEntry(sessionId, (entry) => ({
            ...entry,
            compactThreshold: compactPromptTokenThreshold,
            updateTime: new Date().toISOString()
          }));
        }

        if (session.activeTokens > compactPromptTokenThreshold) {
          const beforeTokens = session.activeTokens;
          const message = this.buildAssistantMessage(
            sessionId,
            `Context usage ${formatTokenCount(beforeTokens)}/${formatTokenCount(compactPromptTokenThreshold)}, compacting...`,
            null
          );
          this.onAssistantMessage(message, false);
          await this.compactSession(sessionId, sessionController.signal);
          const after = this.getSession(sessionId);
          if (after) {
            const afterMessage = this.buildAssistantMessage(
              sessionId,
              `Compacted: ${formatTokenCount(beforeTokens)} → ${formatTokenCount(after.activeTokens)} tokens`,
              null
            );
            afterMessage.meta = { asThinking: true };
            this.onAssistantMessage(afterMessage, false);
          }
        }

        const messages = this.buildOpenAIMessages(this.listSessionMessages(sessionId), currentThinkingEnabled);
        const thinkingOptions = buildThinkingRequestOptions(currentThinkingEnabled, currentBaseURL, currentReasoningEffort);
        const response = await this.createChatCompletionStream(
          currentClient,
          {
            model: currentModel,
            messages,
            tools: getTools(this.getPromptToolOptions()),
            ...thinkingOptions
          },
          { signal: sessionController.signal },
          sessionId
        );

        const message = response.choices?.[0]?.message;
        const rawContent = message?.content;
        const content = typeof rawContent === "string" ? rawContent : "";
        const rawToolCalls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? null;
        toolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0 ? rawToolCalls : null;
        const rawThinking = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        const thinking = typeof rawThinking === "string" ? rawThinking : null;
        const refusal = (message as { refusal?: string } | undefined)?.refusal ?? null;
        // const html = content ? this.renderMarkdown(content) : "";

        if (this.isInterrupted(sessionId)) {
          return;
        }

        // P2: Flash 质量预检测——若 Flash 响应质量不足则升级为 Pro
        if (wasAutoSwitched && currentModel === "deepseek-v4-flash") {
          const isRefusal = typeof refusal === "string" && refusal.length > 0;
          const isEmpty = content.trim().length === 0 && !toolCalls;
          if (isRefusal || isEmpty) {
            // 回退到 Pro，但不追加 Flash 的劣质响应
            const proClient = this.createOpenAIClient(primaryModel);
            if (proClient.client) {
              currentClient = proClient.client;
              currentModel = proClient.model;
              currentThinkingEnabled = proClient.thinkingEnabled;
              currentBaseURL = proClient.baseURL ?? primary.baseURL;
              currentReasoningEffort = proClient.reasoningEffort ?? primary.reasoningEffort;
              wasAutoSwitched = false;

              // 模型回退是客户端行为，仅通知 UI。
              this.onAssistantMessage(
                this.buildAssistantMessage(
                  sessionId,
                  `[模型回退] Flash ${isRefusal ? "拒绝回答" : "返回空响应"}，已升级为 ${primaryModel} 进行重试。`,
                  null
                ),
                false
              );
              toolCalls = null;  // 重置，以便 Pro 重新分析
              continue;  // 使用 Pro 重试（不消耗迭代次数）
            }
          }
        }

        const assistantMessage = this.buildAssistantMessage(sessionId, content, toolCalls, thinking);
        this.appendSessionMessage(sessionId, assistantMessage);
        this.onAssistantMessage(assistantMessage, true);

        let waitingForUser = false;
        if (toolCalls) {
          lastToolName = this.extractLastToolName(toolCalls);
          // 收集工具复杂度信号：不重复工具类型 + 调用计数
          for (const tc of toolCalls) {
            const fn = (tc as Record<string, unknown> | null)?.function as Record<string, unknown> | null | undefined;
            if (typeof fn?.name === "string" && fn.name) {
              uniqueTools.add(fn.name);
            }
          }
          toolTotal += toolCalls.length;
          const toolAppendResult = await this.appendToolMessages(sessionId, toolCalls);
          waitingForUser = toolAppendResult.waitingForUser;
        }

        // 更新双向切换状态
        if (currentModel === DEEPSEEK_V4_FLASH) {
          roundsOnFlash++;
        } else {
          roundsOnFlash = 0;
        }
        newUserMessage = false;

        if (this.isInterrupted(sessionId)) {
          return;
        }

        const responseUsage = response.usage ?? null;
        const iterationModel = currentModel;
        this.updateSessionEntry(sessionId, (entry) => {
          const currentByModel = entry.usageByModel ?? {};
          const updatedByModel: Record<string, unknown> = { ...currentByModel };
          updatedByModel[iterationModel] = accumulateUsage(currentByModel[iterationModel] ?? null, responseUsage);
          return {
            ...entry,
            assistantReply: content,
            assistantThinking: thinking,
            assistantRefusal: refusal,
            toolCalls,
            usage: accumulateUsage(entry.usage, responseUsage),
            usageByModel: updatedByModel,
            activeTokens: getTotalTokens(responseUsage),
          status: refusal
            ? "failed"
            : waitingForUser
              ? "waiting_for_user"
              : toolCalls
                ? "processing"
                : "completed",
          failReason: refusal ? refusal : entry.failReason,
          updateTime: new Date().toISOString()
        };
      });

        if (refusal) {
          return;
        }

        if (waitingForUser) {
          return;
        }

        if (!toolCalls) {
          return;
        }
      }

      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "completed",
        updateTime: new Date().toISOString()
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(sessionId, "The AI agent has taken several steps but hasn't reached a conclusion yet. Do you want to continue?", null),
        false,
      )
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const aborted = this.isAbortLikeError(error) || sessionController.signal.aborted;
      this.closePendingToolCalls(
        sessionId,
        aborted ? "Interrupted by user." : `Request failed before tool results were recorded: ${errMessage}`
      );
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: aborted ? "interrupted" : "failed",
        failReason: aborted ? "interrupted" : errMessage,
        updateTime: new Date().toISOString()
      }));

      if (!aborted) {
        let displayMessage = `Request failed: ${errMessage}`;
        if (error instanceof Error && error.constructor.name === "APIConnectionError") {
          displayMessage = `Request failed: ${errMessage}\n\nTroubleshooting:\n` +
            `  1. Check network: curl -I https://api.deepseek.com\n` +
            `  2. Check proxy settings (HTTP_PROXY / HTTPS_PROXY)\n` +
            `  3. Verify API key in ~/.deepseek-code/settings.json`;
        }
        this.onAssistantMessage(
          this.buildAssistantMessage(sessionId, displayMessage, null),
          false,
        );
      }
    } finally {
      if (this.sessionControllers.get(sessionId) === sessionController) {
        this.sessionControllers.delete(sessionId);
      }
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt);
    }
  }

  async compactSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    // 硬编码 flash: 摘要是辅助任务，不值得付 Pro 费用。
    // 借鉴 Reasonix: 所有辅助调用 (fold / forceSummary / subagent) 均 hard-code v4-flash + effort=high。
    const flashInfo = this.createOpenAIClient("deepseek-v4-flash");
    const client = flashInfo.client ?? this.createOpenAIClient().client;
    const model = flashInfo.client ? flashInfo.model : this.createOpenAIClient().model;
    const baseURL = flashInfo.baseURL;
    const thinkingEnabled = true;
    const reasoningEffort: "high" | "max" = "high";

    if (!client) {
      return;
    }
    const sessionMessages = this.listSessionMessages(sessionId).filter((message) => !message.compacted);
    if (sessionMessages.length === 0) {
      return;
    }

    const startIndex = sessionMessages.findIndex(
      (message) => message.role !== "system"
    );
    if (startIndex === -1) {
      return;
    }

    const searchStart = Math.floor(startIndex + (sessionMessages.length - startIndex) * 2 / 3);
    let endIndex = -1;
    for (let i = Math.max(searchStart, startIndex); i < sessionMessages.length; i += 1) {
      if (sessionMessages[i].role !== "tool") {
        endIndex = i;
        break;
      }
    }
    if (endIndex === -1 || endIndex <= startIndex) {
      return;
    }

    const compactPrompt = getCompactPrompt(sessionMessages.slice(startIndex, endIndex));
    const thinkingOptions = buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort);
    const response = await this.createChatCompletionStream(client, {
      model,
      messages: [{ role: "user", content: compactPrompt }],
      ...thinkingOptions
    }, signal ? { signal } : undefined, sessionId);
    this.throwIfAborted(signal);
    const rawLlmResponse = response.choices?.[0]?.message?.content;
    const llmResponse = typeof rawLlmResponse === "string" ? rawLlmResponse : "";
    const compactedSummary = llmResponse.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();

    const now = new Date().toISOString();
    const responseUsage = response.usage ?? null;
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      usage: accumulateUsage(entry.usage, responseUsage),
      activeTokens: getTotalTokens(responseUsage),
      updateTime: now
    }));

    for (let i = startIndex; i < endIndex; i += 1) {
      sessionMessages[i] = { ...sessionMessages[i], compacted: true, updateTime: now };
    }

    const summaryMessage: SessionMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content: `There are earlier parts of the conversation. Here is a summary: \n\n${compactedSummary}`,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now,
      meta: {
        isSummary: true
      }
    };
    sessionMessages.splice(endIndex, 0, summaryMessage);
    this.saveSessionMessages(sessionId, sessionMessages);
  }

  private getPromptToolOptions(): { webSearchEnabled: boolean } {
    return {
      webSearchEnabled: true
    };
  }

  interruptActiveSession(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const sessionId = this.activeSessionId;
    if (sessionId) {
      this.interruptSession(sessionId);
    }
  }

  interruptSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    const processIds = this.getProcessIds(session?.processes ?? null);
    const killedPids: number[] = [];
    const failedPids: number[] = [];
    for (const pid of processIds) {
      const killedGroup = this.killProcessGroup(pid);
      if (killedGroup) {
        killedPids.push(pid);
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
        killedPids.push(pid);
      } catch {
        failedPids.push(pid);
      }
    }

    const controller = this.sessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionControllers.delete(sessionId);
    }

    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "interrupted",
      failReason: "interrupted",
      processes: null,
      updateTime: now
    }));

    this.closePendingToolCalls(sessionId, "Interrupted by user.");

    const contentParts = ["Interrupted."];
    if (killedPids.length > 0) {
      contentParts.push(`Killed processes: ${killedPids.join(", ")}.`);
    }
    if (failedPids.length > 0) {
      contentParts.push(`Failed to kill processes: ${failedPids.join(", ")}.`);
    }

    this.onAssistantMessage(
      this.buildUserMessage(sessionId, { text: contentParts.join(" ") }),
      false,
    );
  }

  private isInterrupted(sessionId: string): boolean {
    return !this.sessionControllers.has(sessionId);
  }

  listSessions(): SessionEntry[] {
    const index = this.loadSessionsIndex();
    // CLI 启动时仍标记为 "processing" 的会话是过期的——
    // 说明上一次运行被中断或崩溃了。
    const now = new Date().toISOString();
    let dirty = false;
    for (const entry of index.entries) {
      if (entry.status === "processing") {
        entry.status = "interrupted";
        entry.failReason = entry.failReason ?? "Previous session did not complete.";
        entry.updateTime = now;
        dirty = true;
      }
    }
    if (dirty) {
      this.saveSessionsIndex(index);
    }
    return index.entries;
  }

  getSession(sessionId: string): SessionEntry | null {
    const index = this.loadSessionsIndex();
    return index.entries.find((entry) => entry.id === sessionId) ?? null;
  }

  listSessionMessages(sessionId: string): SessionMessage[] {
    const messagePath = this.getSessionMessagesPath(sessionId);
    if (!fs.existsSync(messagePath)) {
      return [];
    }

    const raw = fs.readFileSync(messagePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const messages: SessionMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SessionMessage;
        messages.push(this.normalizeSessionMessage(parsed));
      } catch {
        // ignore malformed line
      }
    }
    return messages;
  }

  private normalizeSessionMessage(message: SessionMessage): SessionMessage {
    if (message.role !== "tool") {
      return message;
    }

    const nextMeta = message.meta ? { ...message.meta } : undefined;
    const normalizedParamsMd = this.buildToolParamsSnippet(nextMeta?.function ?? null);
    if (nextMeta && normalizedParamsMd) {
      nextMeta.paramsMd = normalizedParamsMd;
    }

    const normalizedResultMd =
      typeof message.content === "string" ? this.buildToolResultSnippet(message.content) : "";
    if (nextMeta && normalizedResultMd) {
      nextMeta.resultMd = normalizedResultMd;
    }

    return {
      ...message,
      visible: typeof message.visible === "boolean" ? message.visible : (typeof message.content === "string" ? !this.isInvisibleExecution(message.content) : false),
      meta: nextMeta
    };
  }

  private getProjectCode(projectRoot: string): string {
    return projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
  }

  private getProjectStorage(): {
    projectCode: string;
    projectDir: string;
    sessionsIndexPath: string;
  } {
    const projectCode = this.getProjectCode(this.projectRoot);
    const projectDir = path.join(os.homedir(), ".deepseek-code", "projects", projectCode);
    const sessionsIndexPath = path.join(projectDir, "sessions-index.json");
    return { projectCode, projectDir, sessionsIndexPath };
  }

  private ensureProjectDir(): string {
    const { projectDir } = this.getProjectStorage();
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  }

  private loadSessionsIndex(): SessionsIndex {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();

    if (!fs.existsSync(sessionsIndexPath)) {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }

    try {
      const raw = fs.readFileSync(sessionsIndexPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsIndex;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => this.normalizeSessionEntry(entry))
        : [];
      return {
        version: 1,
        entries,
        originalPath: parsed.originalPath || this.projectRoot
      };
    } catch {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
  }

  private saveSessionsIndex(index: SessionsIndex): void {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();
    const normalized = {
      version: 1,
      entries: index.entries.map((entry) => ({
        ...entry,
        processes: this.serializeProcesses(entry.processes)
      })),
      originalPath: this.projectRoot
    };
    fs.writeFileSync(sessionsIndexPath, JSON.stringify(normalized, null, 2), "utf8");
  }

  private getSessionMessagesPath(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  private removeSessionMessages(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messagePath = this.getSessionMessagesPath(sessionId);
      try {
        if (fs.existsSync(messagePath)) {
          fs.unlinkSync(messagePath);
        }
      } catch {
        // ignore delete failures
      }
    }
  }

  /** Permanently delete sessions and their message files. Returns the number of removed sessions. */
  removeSessions(sessionIds: string[]): number {
    const idSet = new Set(sessionIds);
    const index = this.loadSessionsIndex();
    const removed = index.entries.filter((entry) => idSet.has(entry.id));
    index.entries = index.entries.filter((entry) => !idSet.has(entry.id));
    this.saveSessionsIndex(index);
    this.removeSessionMessages(removed.map((entry) => entry.id));

    // Clear active session if the deleted one was active
    if (this.activeSessionId && idSet.has(this.activeSessionId)) {
      this.activeSessionId = null;
    }

    return removed.length;
  }

  private appendSessionMessage(sessionId: string, message: SessionMessage): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    fs.appendFileSync(messagePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  private saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    const payload = messages.map((message) => JSON.stringify(message)).join("\n");
    fs.writeFileSync(messagePath, payload ? `${payload}\n` : "", "utf8");
  }

  private updateSessionEntry(
      sessionId: string,
      updater: (entry: SessionEntry) => SessionEntry
  ): SessionEntry | null {
    const index = this.loadSessionsIndex();
    const entryIndex = index.entries.findIndex((entry) => entry.id === sessionId);
    if (entryIndex === -1) {
      return null;
    }

    const updated = updater({ ...index.entries[entryIndex] });
    index.entries[entryIndex] = updated;
    this.saveSessionsIndex(index);
    this.onSessionEntryUpdated?.(updated);
    return updated;
  }

  private buildUserMessage(sessionId: string, prompt: UserPromptContent): SessionMessage {
    const now = new Date().toISOString();
    const imageParams =
        prompt.imageUrls
            ?.filter((url) => Boolean(url))
            .map((url) => ({
              type: "image_url",
              image_url: { url }
            })) ?? [];

    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: prompt.text ?? "",
      contentParams: imageParams.length > 0 ? imageParams : null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now
    };
  }

  private loadAgentInstructions(): string | null {
    const candidatePaths = [
      path.join(this.projectRoot, ".deepseek-code", "AGENTS.md"),
      path.join(os.homedir(), ".deepseek-code", "AGENTS.md")
    ];

    for (const candidatePath of candidatePaths) {
      try {
        if (!fs.existsSync(candidatePath)) {
          continue;
        }
        const content = fs.readFileSync(candidatePath, "utf8").trim();
        if (content) {
          return content;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private buildSystemMessage(
    sessionId: string,
    content: string,
    contentParams: unknown | null = null
  ): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content,
      contentParams,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now
    };
  }

  private buildAssistantMessage(
      sessionId: string,
      content: string | null,
      toolCalls: unknown[] | null,
      reasoningContent?: string | null
  ): SessionMessage {
    const now = new Date().toISOString();
    const hasReasoningContent = reasoningContent != null;
    const messageParams: { tool_calls?: unknown[]; reasoning_content?: string } | null =
      toolCalls || hasReasoningContent ? {} : null;
    if (toolCalls) {
      messageParams!.tool_calls = toolCalls;
    }
    if (hasReasoningContent) {
      messageParams!.reasoning_content = reasoningContent;
    }
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content,
      contentParams: null,
      messageParams,
      compacted: false,
      visible: (content || reasoningContent || "").trim() ? true : false,
      createTime: now,
      updateTime: now,
      meta: toolCalls ? { asThinking: true } : undefined
    };
  }

  private buildToolMessage(
    sessionId: string,
    toolCallId: string,
    content: string,
    toolFunction: unknown | null,
    /** true = 隐藏工具执行结果（仅用于步骤模式） */
    hideResult?: boolean
  ): SessionMessage {
    const now = new Date().toISOString();
    const shrunkContent = this.shrinkToolResult(content);
    const paramsMd = this.buildToolParamsSnippet(toolFunction);
    const resultMd = this.buildToolResultSnippet(shrunkContent);
    const isInvisibleExecution = this.isInvisibleExecution(shrunkContent);
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "tool",
      content: shrunkContent,
      contentParams: null,
      messageParams: { tool_call_id: toolCallId },
      compacted: false,
      visible: hideResult ? false : !isInvisibleExecution,
      createTime: now,
      updateTime: now,
      meta: {
        function: toolFunction ?? undefined,
        paramsMd,
        resultMd
      }
    };
  }

  /** 借鉴 Reasonix Pillar-3：单次 tool result 超过此字符数时截断。
   *  后续轮次如需完整内容，模型可主动 read_file 重读——
   *  一次重读远便宜于每轮拖拽 12KB。 */
  private static readonly MAX_TOOL_RESULT_CHARS = 6000;

  private shrinkToolResult(content: string): string {
    if (content.length <= SessionManager.MAX_TOOL_RESULT_CHARS) return content;

    // 尝试解析为 JSON: 仅截断 output 字段，保留结构
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.output === "string" && parsed.output.length > SessionManager.MAX_TOOL_RESULT_CHARS) {
        const out = parsed.output;
        const half = Math.floor(SessionManager.MAX_TOOL_RESULT_CHARS / 2);
        const head = out.slice(0, half);
        const tail = out.slice(-half);
        const skipped = out.length - half * 2;
        parsed.output = [
          head,
          `\n… (truncated ${skipped} chars in output, use read_file to re-fetch if needed)\n`,
          tail,
        ].join("");
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // 非 JSON 内容：回退到原始字符串截断
    }

    // 原始字符串头尾保留
    const half = Math.floor(SessionManager.MAX_TOOL_RESULT_CHARS / 2);
    const head = content.slice(0, half);
    const tail = content.slice(-half);
    const skipped = content.length - half * 2;
    return [
      head,
      `\n… (truncated ${skipped} chars, use read_file to re-fetch if needed)\n`,
      tail,
    ].join("");
  }

  /** 从 tool call 参数生成人类可读的步骤描述 */
  private getStepDescription(toolFunction: unknown): string {
    if (!toolFunction || typeof toolFunction !== "object") {
      return "正在执行...";
    }
    const name = typeof (toolFunction as { name?: unknown }).name === "string"
      ? (toolFunction as { name: string }).name
      : "";
    const rawArgs = typeof (toolFunction as { arguments?: unknown }).arguments === "string"
      ? (toolFunction as { arguments: string }).arguments
      : "";
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch { /* ignore */ }

    const firstValue = (keys: string[]): string => {
      for (const key of keys) {
        const v = args[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };

    switch (name) {
      case "read":
        return `正在读取文件  ${firstValue(["file_path"]) || ""}`;
      case "write":
        return `正在创建文件  ${firstValue(["file_path"]) || ""}`;
      case "edit":
        return `正在修改文件  ${firstValue(["file_path"]) || ""}`;
      case "bash":
        return `正在执行命令  ${firstValue(["command", "description"]) || ""}`;
      case "glob":
        return `正在搜索文件  ${firstValue(["pattern"]) || ""}`;
      case "grep":
        return `正在搜索内容  ${firstValue(["pattern"]) || ""}`;
      case "WebSearch":
        return `正在搜索网络  ${firstValue(["query"]) || ""}`;
      case "AskUserQuestion":
        return `正在向用户提问`;
      default:
        return name ? `正在执行 ${name}` : "正在执行...";
    }
  }

  /** 构建步骤指示器消息（在执行工具调用前显示） */
  private buildStepIndicatorMessage(sessionId: string, stepDescription: string): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "tool",
      content: "",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: {
        isStepIndicator: true,
        stepDescription
      } as Record<string, unknown>
    };
  }

  private async appendToolMessages(
    sessionId: string,
    toolCalls: unknown[]
  ): Promise<{ waitingForUser: boolean }> {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { waitingForUser: false };
    }

    // 从原始 toolCalls 中提取函数信息
    const getToolFunc = (toolCallId: string): unknown | null => {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const record = tc as { id?: unknown; function?: unknown };
        if (record.id === toolCallId) return record.function ?? null;
      }
      return null;
    };

    const getName = (tc: unknown): string | null => {
      if (!tc || typeof tc !== "object") return null;
      const func = (tc as { function?: { name?: unknown } }).function;
      if (!func || typeof func !== "object") return null;
      return typeof func.name === "string" && func.name ? func.name : null;
    };

    let waitingForUser = false;
    const followUpMessages: SessionMessage[] = [];

    for (const rawTc of toolCalls) {
      if (!rawTc || typeof rawTc !== "object") continue;
      const tcId = typeof (rawTc as { id?: unknown }).id === "string"
        ? (rawTc as { id: string }).id
        : "";

      // 1. 步骤指示器（AskUserQuestion 除外）
      const isAskUser = getName(rawTc) === "AskUserQuestion";
      if (!isAskUser) {
        const toolFunction = getToolFunc(tcId);
        const stepDesc = this.getStepDescription(toolFunction);
        const stepMessage = this.buildStepIndicatorMessage(sessionId, stepDesc);
        this.appendSessionMessage(sessionId, stepMessage);
        this.onAssistantMessage(stepMessage, true);
      }

      // 2. 执行这一个 tool call
      const [execution] = await this.toolExecutor.executeToolCalls(sessionId, [rawTc], {
        onProcessStart: (pid, command) => this.addSessionProcess(sessionId, pid, command),
        onProcessExit: (pid) => this.removeSessionProcess(sessionId, pid),
        shouldStop: () => this.isInterrupted(sessionId)
      });

      if (this.isInterrupted(sessionId)) {
        break;
      }

      if (execution.result.awaitUserResponse === true) {
        waitingForUser = true;
      }

      // 3. 追加工具结果（AskUserQuestion 正常显示，其余隐藏）
      const toolFunction = getToolFunc(execution.toolCallId);
      const toolMsg = this.buildToolMessage(
        sessionId,
        execution.toolCallId,
        execution.content,
        toolFunction,
        !isAskUser  // hideResult
      );
      this.appendSessionMessage(sessionId, toolMsg);
      this.onAssistantMessage(toolMsg, true);

      for (const followUpMessage of execution.result.followUpMessages ?? []) {
        if (followUpMessage.role !== "system") continue;
        followUpMessages.push(
          this.buildSystemMessage(sessionId, followUpMessage.content, followUpMessage.contentParams ?? null)
        );
      }
    }

    for (const followUpMessage of followUpMessages) {
      this.appendSessionMessage(sessionId, followUpMessage);
    }
    return { waitingForUser };
  }

  private buildOpenAIMessages(
    messages: SessionMessage[],
    thinkingEnabled: boolean,
  ): ChatCompletionMessageParam[] {
    return messages
        .filter((message) => !message.compacted && !message.meta?.isStepIndicator)
        .map((message) => {
          const base: ChatCompletionMessageParam = {
            role: message.role,
            content: message.content ?? ""
          } as ChatCompletionMessageParam;

          const messageParams = message.messageParams as
              | { tool_calls?: unknown[]; tool_call_id?: string; reasoning_content?: string }
              | null
              | undefined;
          if (messageParams?.tool_calls) {
            (base as { tool_calls?: unknown[] }).tool_calls = messageParams.tool_calls;
          }
          if (messageParams?.tool_call_id) {
            (base as { tool_call_id?: string }).tool_call_id = messageParams.tool_call_id;
          }
          if (typeof messageParams?.reasoning_content === "string") {
            (base as { reasoning_content?: string }).reasoning_content = messageParams.reasoning_content;
          } else if (thinkingEnabled && message.role === "assistant") {
            // Thinking-mode providers require every replayed assistant message
            // to include the reasoning_content field, even when it is empty.
            (base as { reasoning_content?: string }).reasoning_content = "";
          }

          if ((message.role === "user" || message.role === "system") && message.contentParams) {
            const contentParts: ChatCompletionContentPart[] = [];
            if (message.content) {
              contentParts.push({ type: "text", text: message.content });
            }
            const params = Array.isArray(message.contentParams)
                ? message.contentParams
                : [message.contentParams];
            for (const param of params) {
              if (param && typeof param === "object") {
                contentParts.push(param as ChatCompletionContentPart);
              }
            }
            const contentValue: string | ChatCompletionContentPart[] =
                contentParts.length > 0 ? contentParts : message.content ?? "";
            (base as { content: string | ChatCompletionContentPart[] }).content = contentValue;
          }

          return base;
        });
  }

  private findToolFunction(toolCalls: unknown[], toolCallId: string): unknown | null {
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const record = toolCall as { id?: unknown; function?: unknown };
      if (record.id === toolCallId) {
        return record.function ?? null;
      }
    }
    return null;
  }

  private buildToolParamsSnippet(toolFunction: unknown | null): string {
    if (!toolFunction || typeof toolFunction !== "object") {
      return "";
    }
    const args = (toolFunction as { arguments?: unknown }).arguments;
    const toolName = (toolFunction as { name?: unknown }).name;
    if (typeof args !== "string") {
      return "";
    }
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return this.formatToolParamsSnippet(
          typeof toolName === "string" ? toolName : null,
          parsed as Record<string, unknown>
        );
      }
    } catch {
      // fall back to raw string
    }
    return trimmed;
  }

  private formatToolParamsSnippet(toolName: string | null, args: Record<string, unknown>): string {
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      if (command && description) {
        return `${command}  # ${description}`;
      }
      if (command) {
        return command;
      }
      if (description) {
        return description;
      }
    }

    const firstKey = Object.keys(args)[0];
    if (!firstKey) {
      return "";
    }

    const value = args[firstKey];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (toolName === "read" && text.startsWith(this.projectRoot)) {
      return text.slice(this.projectRoot.length).replace(/^[\\/]/, "");
    }
    return text;
  }

  private buildToolResultSnippet(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }

    const maxLength = 2000;

    try {
      const parsed = JSON.parse(content) as { output?: unknown };
      if (parsed.output !== undefined) {
        if (typeof parsed.output === "string") {
          return this.formatToolResultSnippet(parsed.output, maxLength);
        }
        return this.formatToolResultSnippet(JSON.stringify(parsed.output), maxLength);
      }
    } catch {
      // fall back to raw content
    }

    return this.formatToolResultSnippet(content, maxLength);
  }

  private formatToolResultSnippet(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}... (total ${value.length} chars)`;
  }

  /**
   * 失败的 bash 命令不应弄乱消息视图——
   * 它们被视为不透明错误，不会显示给用户。
   */
  private isInvisibleExecution(content: string): boolean {
    if (!content.trim()) {
      return false;
    }
    try {
      const parsed = JSON.parse(content) as { name?: unknown; ok?: unknown };
      if (parsed.name === "bash") {
        // Explicitly failed bash commands are invisible.
        return parsed.ok === false;
      }
      return false;
    } catch {
      return false;
    }
  }

  private maybeNotifyTaskCompletion(
    sessionId: string,
    notifyCommand: string | undefined,
    startedAt: number
  ): void {
    if (!notifyCommand) {
      return;
    }

    const session = this.getSession(sessionId);
    if (!session || (session.status !== "completed" && session.status !== "failed")) {
      return;
    }

    launchNotifyScript(notifyCommand, Date.now() - startedAt, this.projectRoot);
  }

  private addSessionProcess(sessionId: string, processId: string | number, command: string): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.set(String(processId), { startTime: now, command });
      return {
        ...entry,
        processes,
        updateTime: now
      };
    });
  }

  private removeSessionProcess(sessionId: string, processId: string | number): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.delete(String(processId));
      return {
        ...entry,
        processes: processes.size > 0 ? processes : null,
        updateTime: now
      };
    });
  }

  private getProcessIds(processes: Map<string, { startTime: string; command: string }> | null): number[] {
    if (!processes) {
      return [];
    }
    const ids: number[] = [];
    for (const pid of processes.keys()) {
      const parsed = Number(pid);
      if (Number.isInteger(parsed) && parsed > 0) {
        ids.push(parsed);
      }
    }
    return ids;
  }

  private closePendingToolCalls(sessionId: string, reason: string): void {
    const messages = this.listSessionMessages(sessionId);
    let changed = false;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "assistant") {
        continue;
      }

      const messageParams = message.messageParams as { tool_calls?: unknown[] } | null;
      const toolCalls = messageParams?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        continue;
      }

      const expectedToolCallIds = this.getExpectedToolCallIds(toolCalls);
      if (expectedToolCallIds.length === 0) {
        continue;
      }

      let cursor = index + 1;
      const respondedToolCallIds = new Set<string>();
      while (cursor < messages.length && messages[cursor].role === "tool") {
        const toolCallId = (messages[cursor].messageParams as { tool_call_id?: unknown } | null)?.tool_call_id;
        if (typeof toolCallId === "string" && toolCallId) {
          respondedToolCallIds.add(toolCallId);
        }
        cursor += 1;
      }

      const missingToolCallIds = expectedToolCallIds.filter((toolCallId) => !respondedToolCallIds.has(toolCallId));
      if (missingToolCallIds.length === 0) {
        continue;
      }

      const toolMessages = missingToolCallIds.map((toolCallId) => {
        const toolFunction = this.findToolFunction(toolCalls, toolCallId);
        return this.buildToolMessage(
          sessionId,
          toolCallId,
          this.buildInterruptedToolResult(toolFunction, reason),
          toolFunction
        );
      });

      messages.splice(cursor, 0, ...toolMessages);
      changed = true;
      index = cursor + toolMessages.length - 1;
    }

    if (changed) {
      this.saveSessionMessages(sessionId, messages);
    }
  }

  private getExpectedToolCallIds(toolCalls: unknown[]): string[] {
    const ids: string[] = [];
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const id = (toolCall as { id?: unknown }).id;
      if (typeof id === "string" && id) {
        ids.push(id);
      }
    }
    return ids;
  }

  private buildInterruptedToolResult(toolFunction: unknown | null, reason: string): string {
    const toolName =
      toolFunction && typeof toolFunction === "object" && typeof (toolFunction as { name?: unknown }).name === "string"
        ? ((toolFunction as { name: string }).name)
        : "tool";
    return JSON.stringify(
      {
        ok: false,
        name: toolName,
        error: reason,
        metadata: {
          interrupted: true
        }
      },
      null,
      2
    );
  }

  private killProcessGroup(pid: number): boolean {
    if (process.platform === "win32") {
      return false;
    }
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }

  private normalizeSessionEntry(entry: unknown): SessionEntry {
    const value = (entry && typeof entry === "object") ? (entry as Record<string, unknown>) : {};
    return {
      id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
      summary: typeof value.summary === "string" ? value.summary : null,
      assistantReply: typeof value.assistantReply === "string" ? value.assistantReply : null,
      assistantThinking: typeof value.assistantThinking === "string" ? value.assistantThinking : null,
      assistantRefusal: typeof value.assistantRefusal === "string" ? value.assistantRefusal : null,
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : null,
      status: this.normalizeSessionStatus(value.status),
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      usage: value.usage ?? null,
      activeTokens: typeof value.activeTokens === "number" ? value.activeTokens : 0,
      compactThreshold: typeof value.compactThreshold === "number" ? value.compactThreshold : 0,
      createTime: typeof value.createTime === "string" ? value.createTime : new Date().toISOString(),
      updateTime: typeof value.updateTime === "string" ? value.updateTime : new Date().toISOString(),
      processes: this.deserializeProcesses(value.processes)
    };
  }

  private normalizeSessionStatus(status: unknown): SessionStatus {
    if (
      status === "failed" ||
      status === "pending" ||
      status === "processing" ||
      status === "waiting_for_user" ||
      status === "completed" ||
      status === "interrupted"
    ) {
      return status;
    }
    return "pending";
  }

  private deserializeProcesses(value: unknown): Map<string, { startTime: string; command: string }> | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const processes = new Map<string, { startTime: string; command: string }>();
    for (const [pid, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!pid) {
        continue;
      }
      if (typeof entry === "string") {
        // Backward compatibility for old format where just stored start time
        processes.set(pid, { startTime: entry, command: "Running process..." });
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as { startTime?: unknown; command?: unknown };
        const startTime = typeof obj.startTime === "string" ? obj.startTime : new Date().toISOString();
        const command = typeof obj.command === "string" ? obj.command : "Running process...";
        processes.set(pid, { startTime, command });
      }
    }
    return processes.size > 0 ? processes : null;
  }

  private serializeProcesses(processes: Map<string, { startTime: string; command: string }> | null): Record<string, { startTime: string; command: string }> | null {
    if (!processes || processes.size === 0) {
      return null;
    }
    const serialized: Record<string, { startTime: string; command: string }> = {};
    for (const [pid, entry] of processes.entries()) {
      serialized[pid] = entry;
    }
    return serialized;
  }
}
