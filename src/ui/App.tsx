import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import {
  SessionManager,
  type LlmStreamProgress,
  type SessionEntry,
  type SessionMessage,
  type SessionStatus,
  type SkillInfo,
  type UserPromptContent
} from "../session";
import { resolveSettings, getAvailableModelNames, updateActiveModelInSettings, updateModeInSettings, updateThinkingConfigInSettings, updateVerboseModeInSettings, type DeepcodingSettings, type PricingConfig, type ModelMode, type ReasoningEffort, type ResolvedAutoSwitchConfig } from "../settings";
import type { PricingSnapshot } from "../model-capabilities";
import { PromptInput, type PromptSubmission } from "./PromptInput";
import { MessageView } from "./MessageView";
import { useThinkingExpanded } from "./thinkingState";
import { SessionList } from "./SessionList";
import { buildLoadingText } from "./loadingText";
import { WelcomeScreen } from "./WelcomeScreen";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import { HelpOverlay } from "./HelpOverlay";
import { buildStatusLine, statusToEmoji } from "./statusLine";
import { usePromptHandler } from "./usePromptHandler";
import {
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  type AskUserQuestionAnswers
} from "./askUserQuestion";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

// 在模块加载时（Ink 修补 process.stdout 之前）缓存原始终端 fd。
// Ink 启动后 process.stdout 被替换为内部流，此时 process.stdout.fd
// 可能指向 Ink 的内部管道而非原始终端，导致清屏序列被写入错误目标。
const TERMINAL_FD = process.stdout.fd;


// ── 排查日志 ──
const LOG_PATH = "/mnt/d/Java/IdeaProjects/deepseek-code-cli/resume-debug.log";
// 先删除旧日志文件，确保从空白开始记录
try { fs.unlinkSync(LOG_PATH); } catch { /* 文件不存在时忽略 */ }

function logDebug(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  try {
    fs.writeFileSync(LOG_PATH, `[${ts}] ${msg}\n`, { flag: "a" } as any);
  } catch { /* 日志写入失败不阻塞 */ }
}

// 模块加载时记录终端信息和环境变量
const ttyPath = process.stdout.isTTY ? "tty" : "pipe";
const envTerm = (process.env as Record<string, string>)["TERM"] || "unset";
const envTermProg = (process.env as Record<string, string>)["TERM_PROGRAM"] || "unset";
logDebug("MODULE_LOAD", "fd:", TERMINAL_FD, "out.isTTY:", process.stdout?.isTTY, "stderr.isTTY:", process.stderr?.isTTY, "TERM:", envTerm, "TERM_PROGRAM:", envTermProg, "rows:", process.stdout?.rows);
// ──────────────
// 用 process.stdout.write 的原生绑定写清屏序列（在 Ink 修补 stdout 之前捕获）。
const directTerminalWrite = process.stdout.write.bind(process.stdout);

/**
 * Clear the terminal screen and attempt to erase the scrollback buffer.
 *
 * The approach:
 * 1. Standard escape sequences to clear display and scrollback
 * 2. Fill several screenfuls of blank lines to push remaining old
 *    scrollback content out of the buffer (fallback for terminals
 *    where \u001B[3J is ignored).
 * 3. Final clear and home cursor.
 */
function clearTerminal(): void {
  directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
  directTerminalWrite("\u001B[3J");

  // Fallback: blank-line fill pushes old content out of scrollback.
  // Use a large count (>=3000) to exhaust Windows Terminal's large default
  // scrollback buffer (~9000 lines) on WSL2 via ConPTY.
  const rows = process.stdout.rows || 40;
  directTerminalWrite("\n".repeat(Math.max(rows * 30, 10000)));

  directTerminalWrite("\u001B[2J\u001B[H");
}

type View = "chat" | "session-list";

type MessagesState = {
  messages: SessionMessage[];
  staticKey: number;
};

type MessagesAction =
  | { type: "setMessages"; messages: SessionMessage[] }
  | { type: "appendMessage"; message: SessionMessage }
  | { type: "resetMessages" };

function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case "setMessages":
      return { ...state, messages: action.messages };
    case "appendMessage":
      return { ...state, messages: [...state.messages, action.message] };
    case "resetMessages":
      return { messages: [], staticKey: state.staticKey + 1 };
  }
}

type AppProps = {
  projectRoot: string;
  version?: string;
};

export function App({ projectRoot, version = "" }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const [view, setView] = useState<View>("chat");
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [messagesState, dispatchMessages] = useReducer(messagesReducer, { messages: [], staticKey: 0 });
  const messages = messagesState.messages;
  const staticKey = messagesState.staticKey;
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [statusLine, setStatusLine] = useState<string>("");
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] = useState<LlmStreamProgress | null>(null);
  const [runningProcesses, setRunningProcesses] = useState<SessionEntry["processes"]>(null);
  const [activeStatus, setActiveStatus] = useState<SessionStatus | null>(null);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(() => new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [, setNowTick] = useState(0);
  const promptStartTimeRef = useRef<number>(0);
  const prevBusyRef = useRef(false);

  // Model switching
  const initialSettings = useMemo(() => resolveCurrentSettings(), []);
  const [activeModel, setActiveModel] = useState<string>(initialSettings.model);
  const modelList = useMemo(() => getAvailableModelNames(readSettings()), []);

  // Auto-switch mode
  const [activeMode, setActiveMode] = useState<string>(initialSettings.mode);

  // Thinking mode state
  const [activeThinking, setActiveThinking] = useState<boolean>(initialSettings.thinkingEnabled);
  const [activeReasoningEffort, setActiveReasoningEffort] = useState<ReasoningEffort>(initialSettings.reasoningEffort);

  // Verbose mode state (show thinking process & all tool calls)
  const [verboseMode, setVerboseMode] = useState<boolean>(readSettings()?.verboseMode ?? false);

  // Collapsible thinking blocks
  const thinking = useThinkingExpanded(messages);
  const [thinkingRenderKey, setThinkingRenderKey] = useState(0);

  // Keyboard shortcuts for collapsible thinking blocks
  // NOTE: clearTerminal() is required before each toggle because
  // setThinkingRenderKey changes <Static>'s key, which causes Ink to
  // re-mount Static and re-render all items. Without clearing first,
  // old terminal output from the previous Static instance persists,
  // resulting in duplicated messages on screen.
  useInput(
    (input, key) => {
      if (input === "e") {
        clearTerminal();
        thinking.expandAll();
        setThinkingRenderKey((k) => k + 1);
      } else if (input === "c") {
        clearTerminal();
        thinking.collapseAll();
        setThinkingRenderKey((k) => k + 1);
      } else if (input === "t") {
        // Toggle the latest thinking block
        if (thinking.latestThinkingId) {
          clearTerminal();
          thinking.toggle(thinking.latestThinkingId);
          setThinkingRenderKey((k) => k + 1);
        }
      } else if (key.return) {
        // Enter 键不在此全局处理，避免与 PromptInput 的回车提交冲突
        // 用户可用 [t] 键切换最新思考块
        return;
      }
    },
    { isActive: verboseMode && !busy && view === "chat" }
  );

  // 全局快捷键：Ctrl+H / ? 切换帮助面板（在任何视图下可用）
  useInput(
    (input, key) => {
      if (input === "?" || (key.ctrl && input === "h")) {
        setShowHelp((prev) => !prev);
      } else if (key.escape && showHelp) {
        setShowHelp(false);
      }
    },
    { isActive: true }
  );

  const messagesRef = useRef<SessionMessage[]>([]);
  messagesRef.current = messages;
  const activeModelRef = useRef(activeModel);
  activeModelRef.current = activeModel;
  const pricingRef = useRef<Required<PricingConfig>>({ inputPricePerMillion: 0, outputPricePerMillion: 0, inputCacheHitPricePerMillion: 0, inputCacheMissPricePerMillion: 0 });
  const sessionManager = useMemo(() => {
    return new SessionManager({
      projectRoot,
      createOpenAIClient: (override) => createOpenAIClient(override),
      getResolvedSettings: () => resolveCurrentSettings(),
      renderMarkdown: (text) => text,
      onAssistantMessage: (message: SessionMessage) => {
        dispatchMessages({ type: "appendMessage", message });
      },
      onSessionEntryUpdated: (entry) => {
        setStatusLine(buildStatusLine(entry, activeModelRef.current, pricingRef.current));
        setRunningProcesses(entry.processes);
        setActiveStatus(entry.status);
      },
      onLlmStreamProgress: (progress) => {
        if (progress.phase === "end") {
          setStreamProgress(null);
          return;
        }
        setStreamProgress(progress);
      }
    });
  }, [projectRoot]);

  const { handlePrompt, isSubmittingRef } = usePromptHandler({
    sessionManager,
    dispatchMessages,
    setBusy,
    setStatusLine,
    setErrorLine,
    setRunningProcesses,
    setActiveStatus,
    setDismissedQuestionIds,
    setStreamProgress,
    setView,
    refreshSessionsList,
    refreshSkills,
    clearTerminal,
    exit,
    pricingRef,
    resolveModelPricing,
  });

  useEffect(() => {
    if (!busy) {
      return;
    }
    const id = setInterval(() => setNowTick((tick) => tick + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    refreshSessionsList();
    const list = sessionManager.listSessions();
    if (list.length > 0) {
      const latest = list[0];
      sessionManager.setActiveSessionId(latest.id);
      dispatchMessages({ type: "setMessages", messages: loadVisibleMessages(sessionManager, latest.id) });
      setStatusLine(buildStatusLine(latest, activeModelRef.current, pricingRef.current));
      setRunningProcesses(latest.processes);
      setActiveStatus(latest.status);
      void refreshSkills(latest.id);
    } else {
      void refreshSkills();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadVisibleMessages(manager: SessionManager, sessionId: string): SessionMessage[] {
    return manager.listSessionMessages(sessionId);
  }

  function refreshSessionsList(): void {
    setSessions(sessionManager.listSessions());
  }

  async function refreshSkills(sessionId?: string): Promise<void> {
    try {
      const list = await sessionManager.listSkills(sessionId ?? sessionManager.getActiveSessionId() ?? undefined);
      setSkills(list);
    } catch {
      // ignore
    }
  }

  const handleModelChange = useCallback((modelName: string) => {
    const ok = updateActiveModelInSettings(modelName);
    if (ok) {
      setActiveModel(modelName);
    }
  }, []);

  const handleAutoSwitchChange = useCallback((newMode: string) => {
    const ok = updateModeInSettings(newMode as ModelMode);
    if (ok) {
      setActiveMode(newMode);
    }
  }, []);

  const handleThinkingChange = useCallback((thinkingEnabled: boolean, reasoningEffort?: ReasoningEffort) => {
    const ok = updateThinkingConfigInSettings(thinkingEnabled, reasoningEffort);
    if (ok) {
      setActiveThinking(thinkingEnabled);
      if (reasoningEffort) {
        setActiveReasoningEffort(reasoningEffort);
      }
    }
  }, []);

  const handleVerboseChange = useCallback((verbose: boolean) => {
    const ok = updateVerboseModeInSettings(verbose);
    if (ok) {
      setVerboseMode(verbose);
    }
  }, []);



  const handleInterrupt = useCallback(() => {
    sessionManager.interruptActiveSession();
    // 5.3 中断确认提示：显示 "⚠ 已中断" 1.5 秒后自动消失
    setErrorLine("⚠ 已中断");
    setTimeout(() => setErrorLine((prev) => prev === "⚠ 已中断" ? null : prev), 1500);
  }, [sessionManager]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      logDebug("HANDLE_SELECT sessionId:", sessionId, "curr_view:", view, "messages.length:", messages.length);
      // 先切换会话、清屏、切视图、重置消息 —— 这些操作必须在加载数据之前完成。
      // 原因：React 17 在 Ink 的 useInput 回调（非 React 事件）中不会批处理状态更新，
      // 每个 dispatch / setState 都会触发一次同步渲染。若 setView("chat") 在最后执行，
      // 中间渲染会把 SessionList 重新画回已被 clearTerminal() 清空的屏幕上。
      sessionManager.setActiveSessionId(sessionId);
      // Same clearTerminal() as /new and /resume — ensures old Static output
      // is wiped from both display and scrollback before new messages render.
      clearTerminal();
      // 立即切换到 chat 视图，卸载 SessionList
      setView("chat");
      logDebug("VIEW_CHANGED_to_chat (handleSelectSession)");
      // resetMessages increments staticKey → Static re-renders; 清空旧消息
      dispatchMessages({ type: "resetMessages" });

      try {
        // 加载新会话的消息（可能因磁盘错误而失败，但视图已是 chat）
        dispatchMessages({ type: "setMessages", messages: loadVisibleMessages(sessionManager, sessionId) });
        const session = sessionManager.getSession(sessionId);
        setStatusLine(session ? buildStatusLine(session, activeModelRef.current, pricingRef.current) : "");
        setRunningProcesses(session?.processes ?? null);
        setActiveStatus(session?.status ?? null);
        await refreshSkills(sessionId);
      } catch {
        // 数据加载失败时视图已是 chat，只需忽略错误；
        // 状态行和错误行已在 handlePrompt 的 /resume 分支中清空。
      }
    },
    [sessionManager]
  );

  const screenWidth = stdout?.columns ?? 80;
  const promptHistory = useMemo(() => {
    return messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => (message.content ?? "").trim())
      .filter((content) => content.length > 0);
  }, [messages]);
  const pendingQuestion = useMemo(
    () => findPendingAskUserQuestion(messages, activeStatus),
    [activeStatus, messages]
  );
  const shouldShowQuestionPrompt = Boolean(
    pendingQuestion && !dismissedQuestionIds.has(pendingQuestion.messageId)
  );
  // 非 verbose 模式：将连续的工具调用归组显示
  // verbose 模式下展示所有 tool 消息
  const displayMessages = useMemo(() => {
    if (verboseMode) return messages;

    // 找到最后一个 assistant 消息的位置
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }

    const groupStart = lastAssistantIdx + 1;
    if (groupStart >= messages.length) return messages;

    const groupMsgs = messages.slice(groupStart);
    const toolCount = groupMsgs.filter((m) => m.role === "tool").length;

    if (toolCount === 0) return messages;

    // ≤2 个工具不分组，直接展示
    if (toolCount <= 2) return messages;

    // 找到最后一条 tool 消息
    let lastToolMsg: SessionMessage | null = null;
    for (let i = groupMsgs.length - 1; i >= 0; i--) {
      if (groupMsgs[i].role === "tool") {
        lastToolMsg = groupMsgs[i];
        break;
      }
    }

    const prefix = messages.slice(0, groupStart);
    const summaryType = categorizeToolGroup(groupMsgs);
    const now = new Date().toISOString();
    const result: SessionMessage[] = [...prefix];

    // 注入分组摘要消息（asThinking 样式显示）
    result.push({
      id: `toolgroup-${Math.random().toString(36).slice(2)}`,
      sessionId: messages[0]?.sessionId ?? "local",
      role: "assistant",
      content: `🔍 ${summaryType} (${toolCount} 个工具)`,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: { asThinking: true, isToolGroup: true },
    });

    if (lastToolMsg) result.push(lastToolMsg);
    return result;
  }, [messages, verboseMode]);

/** 将一组 tool 消息分类为可读的摘要名称 */
function categorizeToolGroup(msgs: SessionMessage[]): string {
  const names = new Set<string>();
  for (const msg of msgs) {
    if (msg.role !== "tool") continue;
    // 从 tool 消息的 meta 中提取工具名
    const metaFn = msg.meta?.function as { name?: string } | undefined;
    const name = metaFn?.name;
    if (name) names.add(name);
  }

  const nameArr = Array.from(names);
  if (nameArr.length === 0) return "工具调用";

  // 按类别归类
  const reads = nameArr.filter((n) => ["read", "handle_read", "grep", "glob", "directory_tree", "get_file_info"].includes(n));
  const writes = nameArr.filter((n) => ["write", "edit", "multi_edit"].includes(n));
  const searches = nameArr.filter((n) => ["WebSearch", "web_fetch"].includes(n));
  const others = nameArr.filter((n) => !reads.includes(n) && !writes.includes(n) && !searches.includes(n));

  const parts: string[] = [];
  if (reads.length > 0) parts.push("代码探索");
  if (writes.length > 0) parts.push("代码修改");
  if (searches.length > 0) parts.push("网络搜索");
  if (others.length > 0) parts.push(others.join("/"));

  return parts.join(" + ");
}

  // Recalculated every render so the elapsed-time counter ticks in real time.
  const loadingText = busy
    ? buildLoadingText({ progress: streamProgress, processes: runningProcesses, now: Date.now() })
    : null;

  // 终端标题栏 & 响铃通知
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;

    // 响铃通知：模型响应完成时 (busy: true → false)
    if (wasBusy && !busy) {
      if (activeStatus === "failed") {
        // 5.4 失败时双响铃
        process.stdout.write("\x07\x07");
      } else {
        process.stdout.write("\x07");
      }
    }

    // 终端标题栏：实时显示思考状态，翻看历史时也能看到
    if (busy) {
      const titleStatus = loadingText ?? "Generating...";
      process.stdout.write(`\x1b]0;⏳ ${titleStatus} — DeepSeek Code\x07`);
    } else if (activeStatus === "completed") {
      // 完成时标题栏闪烁通知
      process.stdout.write("\x1b]0;⚡ DeepSeek Code — 响应完成\x07");
    } else if (activeStatus === "failed") {
      process.stdout.write("\x1b]0;✗ DeepSeek Code — 响应失败\x07");
    } else {
      process.stdout.write("\x1b]0;DeepSeek Code\x07");
    }
  }, [busy, loadingText, activeStatus]);

  // Dynamic settings: re-resolve when activeModel changes (model persisting to disk
  // means resolveCurrentSettings picks up the new model + its per-model overrides)
  const welcomeSettings = useMemo(() => resolveCurrentSettings(), [activeModel, activeThinking, activeReasoningEffort]);
  pricingRef.current = welcomeSettings.pricing;

  const handleQuestionAnswers = useCallback(
    (answers: AskUserQuestionAnswers) => {
      void handlePrompt({
        text: formatAskUserQuestionAnswers(answers),
        imageUrls: []
      });
    },
    [handlePrompt]
  );

  const handleQuestionCancel = useCallback(() => {
    if (!pendingQuestion) {
      return;
    }
    setDismissedQuestionIds((prev) => new Set(prev).add(pendingQuestion.messageId));
  }, [pendingQuestion]);

  return (
    <Box flexDirection="column" width={screenWidth}>
      {view === "chat" && messages.length === 0 ? (
        <WelcomeScreen
          key={`welcome-${staticKey}`}
          projectRoot={projectRoot}
          settings={welcomeSettings}
          skills={skills}
          version={version}
          width={screenWidth}
        />
      ) : null}
      {view === "chat" ? (
        <Static key={`messages-${staticKey}-${thinkingRenderKey}`} items={displayMessages}>
          {(message) => {
            // 计算思考过程序号（仅用于 asThinking 消息）
            let thinkingIdx: number | undefined;
            let thinkingTotal: number | undefined;
            if (verboseMode && message.role === "assistant" && message.meta?.asThinking) {
              thinkingTotal = thinking.thinkingCount;
              const idx = thinking.thinkingIds.indexOf(message.id);
              if (idx !== -1) thinkingIdx = thinkingTotal - idx; // 倒序（最新为 1）
            }
            return (
              <MessageView
                key={message.id}
                message={message}
                verboseMode={verboseMode}
                isExpanded={thinking.isExpanded(message.id)}
                onToggle={() => {
                  thinking.toggle(message.id);
                  setThinkingRenderKey((k) => k + 1);
                }}
                thinkingIndex={thinkingIdx}
                totalThinkingCount={thinkingTotal}
              />
            );
          }}
        </Static>
      ) : null}
      {statusLine ? (
        <Box>
          <Text dimColor>{statusLine}</Text>
        </Box>
      ) : null}
      {errorLine ? (
        <Box>
          <Text color="red">Error: {errorLine}</Text>
        </Box>
      ) : null}
      {verboseMode && !busy && view === "chat" && thinking.thinkingCount > 0 ? (
        <Box>
          <Text dimColor>{`  [e]展开全部 · [c]折叠全部 · [t]切换最新思考  (${thinking.thinkingCount}条思考)`}</Text>
        </Box>
      ) : null}
      {view === "session-list" ? (
        <SessionList
          sessions={sessions}
          onSelect={(id) => void handleSelectSession(id)}
          onCancel={() => {
            logDebug("ON_CANCEL (Esc pressed)");
            clearTerminal();
            // resetMessages increments staticKey so Static re-renders
            dispatchMessages({ type: "resetMessages" });
            setView("chat");
            logDebug("VIEW_CHANGED_to_chat (onCancel)");
          }}
          onDelete={(ids) => {
            sessionManager.removeSessions(ids);
            dispatchMessages({ type: "resetMessages" });
            setStatusLine("");
            setActiveStatus(null);
            setView("chat");
            refreshSessionsList();
            clearTerminal();
          }}
        />
      ) : shouldShowQuestionPrompt && pendingQuestion && !busy ? (
        <AskUserQuestionPrompt
          questions={pendingQuestion.questions}
          onSubmit={handleQuestionAnswers}
          onCancel={handleQuestionCancel}
        />
      ) : (
        <PromptInput
          key={staticKey}
          skills={skills}
          activeModel={activeModel}
          modelList={modelList}
          onModelChange={(name) => void handleModelChange(name)}
          activeThinking={activeThinking}
          activeReasoningEffort={activeReasoningEffort}
          onThinkingChange={(enabled, effort) => void handleThinkingChange(enabled, effort)}
          activeMode={activeMode}
          onAutoSwitchChange={(newMode) => void handleAutoSwitchChange(newMode)}
          verboseMode={verboseMode}
          onVerboseChange={(verbose) => void handleVerboseChange(verbose)}
          promptHistory={promptHistory}
          busy={busy}
          loadingText={loadingText}
          onSubmit={(submission) => void handlePrompt(submission)}
          onInterrupt={handleInterrupt}
        />
      )}
      {showHelp ? (
        <HelpOverlay onClose={() => setShowHelp(false)} />
      ) : null}
    </Box>
  );
}


function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * Resolve per-model pricing from settings. Used by buildCompletionSummary
 * to charge each model its own rate (Bug 2 fix).
 */
function resolveModelPricing(modelName: string): Required<PricingConfig> {
  // 绕过 mode 覆写，确保获取到指定模型的正确费率
  const raw = readSettings();
  if (raw) { raw.mode = undefined; }
  if (raw?.env) { raw.env.MODEL = undefined; }
  return resolveSettings(raw, { model: modelName, baseURL: DEFAULT_BASE_URL }).pricing;
}

export function readSettings(): DeepcodingSettings | null {
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as DeepcodingSettings;
  } catch {
    return null;
  }
}

export function resolveCurrentSettings(): ReturnType<typeof resolveSettings> {
  return resolveSettings(readSettings(), {
    model: DEFAULT_MODEL,
    baseURL: DEFAULT_BASE_URL
  });
}

/** 根据 overrideModel 创建 OpenAI 客户端实例，同时解析对应模型的 pricing、thinking 等配置。 */
export function createOpenAIClient(overrideModel?: string): {
  client: OpenAI | null;
  model: string;
  baseURL: string;
  thinkingEnabled: boolean;
  reasoningEffort: "high" | "max";
  notify?: string;
  webSearchTool?: string;
  machineId?: string;
  pricing?: PricingSnapshot;
  autoSwitch?: ResolvedAutoSwitchConfig;
} {
  const settings = overrideModel
    ? (() => {
        const raw = readSettings();
        // Remove env.MODEL so resolveSettings uses the override
        if (raw?.env) { raw.env.MODEL = undefined; }
        return resolveSettings(raw, { model: overrideModel, baseURL: DEFAULT_BASE_URL });
      })()
    : resolveCurrentSettings();
  const pricing: PricingSnapshot = {
    inputCacheHitPricePerMillion: settings.pricing.inputCacheHitPricePerMillion,
    inputCacheMissPricePerMillion: settings.pricing.inputCacheMissPricePerMillion,
    outputPricePerMillion: settings.pricing.outputPricePerMillion,
  };
  const autoSwitch = settings.autoSwitch;
  if (!settings.apiKey) {
    return {
      client: null,
      model: settings.model,
      baseURL: settings.baseURL,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      machineId: getMachineId(),
      pricing,
      autoSwitch
    };
  }

  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    maxRetries: 2,
    timeout: 300_000
  });
  return {
    client,
    model: settings.model,
    baseURL: settings.baseURL,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    machineId: getMachineId(),
    pricing,
    autoSwitch
  };
}

function getMachineId(): string | undefined {
  try {
    const idPath = path.join(os.homedir(), ".deepseek-code", "machine-id");
    if (fs.existsSync(idPath)) {
      const raw = fs.readFileSync(idPath, "utf8").trim();
      if (raw) {
        return raw;
      }
    }
    const generated = `${os.hostname()}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, generated, "utf8");
    return generated;
  } catch {
    return undefined;
  }
}
