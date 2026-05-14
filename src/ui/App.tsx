import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout } from "ink";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import {
  SessionManager,
  getTotalTokens,
  getPromptTokens,
  getCompletionTokens,
  getPromptCacheHitTokens,
  getPromptCacheMissTokens,
  type LlmStreamProgress,
  type SessionEntry,
  type SessionMessage,
  type SessionStatus,
  type SkillInfo,
  type UserPromptContent
} from "../session";
import { resolveSettings, getAvailableModelNames, updateActiveModelInSettings, updateModeInSettings, updateThinkingConfigInSettings, type DeepcodingSettings, type PricingConfig, type ModelMode, type ReasoningEffort, type ResolvedAutoSwitchConfig } from "../settings";
import type { PricingSnapshot } from "../model-capabilities";
import { PromptInput, type PromptSubmission } from "./PromptInput";
import { MessageView } from "./MessageView";
import { SessionList } from "./SessionList";
import { buildLoadingText } from "./loadingText";
import { WelcomeScreen } from "./WelcomeScreen";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import {
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  type AskUserQuestionAnswers
} from "./askUserQuestion";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

// Capture unpatched stdout.write before Ink / PromptInput intercept it.
// Used by clearTerminal() to directly write escape sequences that bypass
// Ink's output interceptor.
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
  const [, setNowTick] = useState(0);
  const handlePromptRef = useRef<(submission: PromptSubmission) => void>(() => {});
  const isSubmittingRef = useRef(false);
  const promptStartTimeRef = useRef<number>(0);

  // Model switching
  const initialSettings = useMemo(() => resolveCurrentSettings(), []);
  const [activeModel, setActiveModel] = useState<string>(initialSettings.model);
  const modelList = useMemo(() => getAvailableModelNames(readSettings()), []);

  // Auto-switch mode
  const [activeMode, setActiveMode] = useState<string>(initialSettings.mode);

  // Thinking mode state
  const [activeThinking, setActiveThinking] = useState<boolean>(initialSettings.thinkingEnabled);
  const [activeReasoningEffort, setActiveReasoningEffort] = useState<ReasoningEffort>(initialSettings.reasoningEffort);

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
        setStatusLine(buildStatusLine(entry, activeModelRef.current));
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
      setStatusLine(buildStatusLine(latest, activeModelRef.current));
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

  const handlePrompt = useCallback(
    async (submission: PromptSubmission) => {
      if (isSubmittingRef.current) {
        return;
      }
      isSubmittingRef.current = true;
      if (submission.command === "exit") {
        exit();
        process.exit(0);
        return;
      }
      if (submission.command === "new") {
        sessionManager.setActiveSessionId(null);
        // Synchronously clear screen before React re-renders,
        // so the old Static output is wiped before new UI appears.
        clearTerminal();
        dispatchMessages({ type: "resetMessages" });
        setStatusLine("");
        setErrorLine(null);
        setRunningProcesses(null);
        setActiveStatus(null);
        setDismissedQuestionIds(new Set());
        refreshSessionsList();
        await refreshSkills();
        isSubmittingRef.current = false;
        return;
      }
      if (submission.command === "resume") {
        // Use clearTerminal() with scrollback fill (same as /new), so old
        // Static output from the previous chat session is fully wiped from
        // both the display and scrollback buffer.  Using bare \u001B[3J alone
        // is unreliable because many terminals (e.g. Windows Terminal) ignore
        // it, leaving old message lines visible above the SessionList.
        clearTerminal();
        // Increment staticKey so <Static> re-mounts with empty items.
        dispatchMessages({ type: "resetMessages" });
        setStatusLine("");
        setErrorLine(null);
        setRunningProcesses(null);
        setActiveStatus(null);
        // Switch view FIRST — in React 17 each setState triggers a synchronous
        // render. If refreshSessionsList fires before setView, the intermediate
        // render still has view="chat", and <Static> writes session messages
        // above the SessionList.
        setView("session-list");
        refreshSessionsList();
        isSubmittingRef.current = false;
        return;
      }

      const prompt: UserPromptContent = {
        text: submission.text,
        imageUrls: submission.imageUrls,
        skills: submission.selectedSkills && submission.selectedSkills.length > 0
          ? submission.selectedSkills
          : undefined
      };

      const trimmedText = (submission.text ?? "").trim();
      const selectedSkillNames = submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ?? [];
      const userDisplayContent = trimmedText
        || (selectedSkillNames.length > 0 ? `Use skills: ${selectedSkillNames.join(", ")}` : "")
        || (submission.imageUrls.length > 0 ? "[Image]" : "");

      if (userDisplayContent) {
        dispatchMessages({
          type: "appendMessage",
          message: buildSyntheticUserMessage(userDisplayContent, submission.imageUrls.length)
        });
      }

      promptStartTimeRef.current = Date.now();
      // Record cumulative tokens before this round so we can compute per-round consumption
      const activeSessionIdBefore = sessionManager.getActiveSessionId();
      const sessionBefore = activeSessionIdBefore ? sessionManager.getSession(activeSessionIdBefore) : null;
      const totalTokensBefore = sessionBefore ? getTotalTokens(sessionBefore.usage) : 0;
      const promptTokensBefore = sessionBefore ? getPromptTokens(sessionBefore.usage) : 0;
      const completionTokensBefore = sessionBefore ? getCompletionTokens(sessionBefore.usage) : 0;
      const cacheHitBefore = sessionBefore ? getPromptCacheHitTokens(sessionBefore.usage) : 0;
      const cacheMissBefore = sessionBefore ? getPromptCacheMissTokens(sessionBefore.usage) : 0;

      // Deep-clone usageByModel numeric fields before the round,
      // so we can later compute the per-model round increment (Bug 1 fix).
      const usageByModelBefore: Record<string, Record<string, number>> = {};
      const rawByModelBefore = sessionBefore?.usageByModel;
      if (rawByModelBefore && typeof rawByModelBefore === "object" && !Array.isArray(rawByModelBefore)) {
        for (const [mn, mu] of Object.entries(rawByModelBefore)) {
          if (mu && typeof mu === "object" && !Array.isArray(mu)) {
            const flat: Record<string, number> = {};
            for (const [k, v] of Object.entries(mu as Record<string, unknown>)) {
              if (typeof v === "number") flat[k] = v;
            }
            if (Object.keys(flat).length > 0) usageByModelBefore[mn] = flat;
          }
        }
      }

      setBusy(true);
      setErrorLine(null);
      setRunningProcesses(null);

      // 让出事件循环，确保 Ink 完成重渲染并启动 spinner 动画后再执行后续同步 I/O
      await new Promise(resolve => setTimeout(resolve, 0));

      try {
        await sessionManager.handleUserPrompt(prompt);
        // Append a completion summary with elapsed time, token usage, and cost
        const elapsedMs = Date.now() - promptStartTimeRef.current;
        const activeSessionId = sessionManager.getActiveSessionId();
        if (activeSessionId) {
          const session = sessionManager.getSession(activeSessionId);
          if (session) {
            const totalTokens = getTotalTokens(session.usage);
            const roundPromptTokens = Math.max(0, getPromptTokens(session.usage) - promptTokensBefore);
            const roundCompletionTokens = Math.max(0, getCompletionTokens(session.usage) - completionTokensBefore);
            const roundTokens = Math.max(0, totalTokens - totalTokensBefore);
            const roundCacheHit = Math.max(0, getPromptCacheHitTokens(session.usage) - cacheHitBefore);
            const roundCacheMiss = Math.max(0, getPromptCacheMissTokens(session.usage) - cacheMissBefore);

            // Compute per-model round increment by subtracting before snapshot (Bug 1 fix)
            const usageByModelDiff: Record<string, Record<string, number>> = {};
            const rawByModelAfter = session.usageByModel;
            if (rawByModelAfter && typeof rawByModelAfter === "object" && !Array.isArray(rawByModelAfter)) {
              for (const [mn, mu] of Object.entries(rawByModelAfter)) {
                if (!mu || typeof mu !== "object" || Array.isArray(mu)) continue;
                const afterRecord = mu as Record<string, unknown>;
                const beforeRecord = usageByModelBefore[mn];
                const diff: Record<string, number> = {};
                for (const [k, v] of Object.entries(afterRecord)) {
                  if (typeof v === "number") {
                    const bv = beforeRecord && typeof beforeRecord[k] === "number" ? beforeRecord[k] : 0;
                    const d = v - bv;
                    if (d > 0) diff[k] = d;
                  }
                }
                if (Object.keys(diff).length > 0) usageByModelDiff[mn] = diff;
              }
            }

            const summaryMessage = buildCompletionSummary(
              session, elapsedMs, roundTokens, roundPromptTokens, roundCompletionTokens,
              roundCacheHit, roundCacheMiss, pricingRef.current,
              usageByModelDiff, resolveModelPricing
            );
            dispatchMessages({ type: "appendMessage", message: summaryMessage });
          }
        }
        await refreshSkills();
        refreshSessionsList();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorLine(message);
      } finally {
        setBusy(false);
        setStreamProgress(null);
        setRunningProcesses(null);
        isSubmittingRef.current = false;
      }
    },
    [exit, sessionManager, write]
  );

  const handleInterrupt = useCallback(() => {
    sessionManager.interruptActiveSession();
  }, [sessionManager]);

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      sessionManager.setActiveSessionId(sessionId);
      // Same clearTerminal() as /new and /resume — ensures old Static output
      // is wiped from both display and scrollback before new messages render.
      clearTerminal();
      // resetMessages increments staticKey → Static re-renders; setMessages loads the data
      dispatchMessages({ type: "resetMessages" });
      dispatchMessages({ type: "setMessages", messages: loadVisibleMessages(sessionManager, sessionId) });
      const session = sessionManager.getSession(sessionId);
      setStatusLine(session ? buildStatusLine(session, activeModelRef.current) : "");
      setRunningProcesses(session?.processes ?? null);
      setActiveStatus(session?.status ?? null);
      setView("chat");
      await refreshSkills(sessionId);
    },
    [sessionManager, write]
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
  // 只保留最新的步骤指示器和最新的 tool 消息，历史指示器和历史 tool 消息隐藏
  const displayMessages = useMemo(() => {
    let lastStepIdx = -1;
    let lastToolIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].meta?.isStepIndicator && lastStepIdx === -1) {
        lastStepIdx = i;
      }
      if (messages[i].role === "tool" && lastToolIdx === -1) {
        lastToolIdx = i;
      }
      if (lastStepIdx !== -1 && lastToolIdx !== -1) break;
    }
    if (lastStepIdx === -1 && lastToolIdx === -1) return messages;
    return messages.filter((m, i) => {
      if (m.meta?.isStepIndicator && i !== lastStepIdx) return false;
      if (m.role === "tool" && i !== lastToolIdx) return false;
      return true;
    });
  }, [messages]);
  // Recalculated every render so the elapsed-time counter ticks in real time.
  const loadingText = busy
    ? buildLoadingText({ progress: streamProgress, processes: runningProcesses, now: Date.now() })
    : null;

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
      <Static key={`messages-${staticKey}`} items={displayMessages}>
        {(message) => (
          <MessageView
            key={message.id}
            message={message}
          />
        )}
      </Static>
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
      {view === "session-list" ? (
        <SessionList
          sessions={sessions}
          onSelect={(id) => void handleSelectSession(id)}
          onCancel={() => {
            clearTerminal();
            // resetMessages increments staticKey so Static re-renders
            dispatchMessages({ type: "resetMessages" });
            setView("chat");
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
          promptHistory={promptHistory}
          busy={busy}
          loadingText={loadingText}
          onSubmit={(submission) => void handlePrompt(submission)}
          onInterrupt={handleInterrupt}
        />
      )}
    </Box>
  );
}

function buildSyntheticUserMessage(content: string, imageCount: number): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `local-${Math.random().toString(36).slice(2)}`,
    sessionId: "local",
    role: "user",
    content,
    contentParams:
      imageCount > 0
        ? Array.from({ length: imageCount }, () => ({
            type: "image_url",
            image_url: { url: "" }
          }))
        : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now
  };
}

export function buildCompletionSummary(
  session: SessionEntry,
  elapsedMs: number,
  roundTokens: number,
  roundPromptTokens: number,
  roundCompletionTokens: number,
  roundCacheHitTokens: number,
  roundCacheMissTokens: number,
  pricing: Required<PricingConfig>,
  /** 本轮每个模型的增量 usage（非累计值），用于模型拆分计费 */
  usageByModelDiff?: Record<string, Record<string, number>>,
  /** 根据模型名解析对应费率的回调；缺省时全部使用 primary pricing（Bug 2 修复需要传此参数） */
  resolveModelPricing?: (modelName: string) => Required<PricingConfig>,
): SessionMessage {
  const now = new Date().toISOString();
  const elapsed = formatElapsed(elapsedMs);

  let statusIcon = "";
  let statusColor = "";
  switch (session.status) {
    case "completed":
      statusIcon = "✓";
      statusColor = "green";
      break;
    case "failed":
      statusIcon = "✗";
      statusColor = "red";
      break;
    case "interrupted":
      statusIcon = "⚠";
      statusColor = "yellow";
      break;
    default:
      statusIcon = "•";
      statusColor = "gray";
  }

  const parts: string[] = [`${statusIcon} ${session.status}`];
  parts.push(`耗时: ${elapsed}`);

  // ── 按模型拆分展示 token、缓存命中率、费用 ──
  if (usageByModelDiff && resolveModelPricing) {
    const modelNames = Object.keys(usageByModelDiff).sort();
    const modelDetailParts: string[] = [];

    for (const modelName of modelNames) {
      const diff = usageByModelDiff[modelName];
      const modelPrompt = typeof diff.prompt_tokens === "number" ? diff.prompt_tokens : 0;
      const modelCompletion = typeof diff.completion_tokens === "number" ? diff.completion_tokens : 0;
      const modelCacheHit = typeof diff.prompt_cache_hit_tokens === "number" ? diff.prompt_cache_hit_tokens : 0;
      const modelCacheMiss = typeof diff.prompt_cache_miss_tokens === "number" ? diff.prompt_cache_miss_tokens : 0;
      const modelTokens = modelPrompt + modelCompletion;

      // Per-model cache hit rate
      const modelCacheTotal = modelCacheHit + modelCacheMiss;
      const modelHitPct = modelCacheTotal > 0
        ? Math.round((modelCacheHit / modelCacheTotal) * 100)
        : undefined;

      // Per-model pricing
      const mp = resolveModelPricing(modelName);
      const mHitPrice = mp.inputCacheHitPricePerMillion > 0
        ? mp.inputCacheHitPricePerMillion
        : mp.inputPricePerMillion;
      const mMissPrice = mp.inputCacheMissPricePerMillion > 0
        ? mp.inputCacheMissPricePerMillion
        : mp.inputPricePerMillion;

      const modelCost = (modelCacheHit / 1_000_000) * mHitPrice
        + (modelCacheMiss / 1_000_000) * mMissPrice
        + (Math.max(0, modelPrompt - modelCacheHit - modelCacheMiss) / 1_000_000) * mp.inputPricePerMillion
        + (modelCompletion / 1_000_000) * mp.outputPricePerMillion;

      const subParts: string[] = [`token=${formatTokenCount(modelTokens)}`];
      if (modelHitPct !== undefined) {
        subParts.push(`缓存命中=${modelHitPct}%`);
      }
      if (modelCost > 0) {
        subParts.push(`费用=¥${formatCost(modelCost)}`);
      }
      modelDetailParts.push(`${modelName}: ${subParts.join(", ")}`);
    }

    if (modelNames.length === 1) {
      // 单一模型：直接展示按模型明细，不再重复展示总数
      parts.push(modelDetailParts[0]);
    } else {
      // 多模型：展示总体合计 + 每个模型的明细
      const cacheTotal = roundCacheHitTokens + roundCacheMissTokens;
      parts.push(`token: ${formatTokenCount(roundTokens)}`);
      if (cacheTotal > 0) {
        const hitPct = Math.round((roundCacheHitTokens / cacheTotal) * 100);
        parts.push(`缓存命中: ${hitPct}%`);
      }

      // 总费用
      const cacheHitPrice = pricing.inputCacheHitPricePerMillion > 0
        ? pricing.inputCacheHitPricePerMillion
        : pricing.inputPricePerMillion;
      const cacheMissPrice = pricing.inputCacheMissPricePerMillion > 0
        ? pricing.inputCacheMissPricePerMillion
        : pricing.inputPricePerMillion;
      let totalCost = 0;
      totalCost += (roundCacheHitTokens / 1_000_000) * cacheHitPrice;
      totalCost += (roundCacheMissTokens / 1_000_000) * cacheMissPrice;
      totalCost += (Math.max(0, roundPromptTokens - cacheTotal) / 1_000_000) * pricing.inputPricePerMillion;
      totalCost += (roundCompletionTokens / 1_000_000) * pricing.outputPricePerMillion;
      if (totalCost > 0) {
        parts.push(`费用: ¥${formatCost(totalCost)}`);
      }

      parts.push(`模型明细: ${modelDetailParts.join(" + ")}`);
    }
  } else {
    // 无 usageByModelDiff 时，回退到原有总体展示
    parts.push(`token: ${formatTokenCount(roundTokens)}`);

    const cacheTotal = roundCacheHitTokens + roundCacheMissTokens;
    if (cacheTotal > 0) {
      const hitPct = Math.round((roundCacheHitTokens / cacheTotal) * 100);
      parts.push(`缓存命中: ${hitPct}%`);
    }

    const cacheHitPrice = pricing.inputCacheHitPricePerMillion > 0
      ? pricing.inputCacheHitPricePerMillion
      : pricing.inputPricePerMillion;
    const cacheMissPrice = pricing.inputCacheMissPricePerMillion > 0
      ? pricing.inputCacheMissPricePerMillion
      : pricing.inputPricePerMillion;

    let cost = 0;
    cost += (roundCacheHitTokens / 1_000_000) * cacheHitPrice;
    cost += (roundCacheMissTokens / 1_000_000) * cacheMissPrice;
    const nonCachePromptTokens = Math.max(0, roundPromptTokens - cacheTotal);
    cost += (nonCachePromptTokens / 1_000_000) * pricing.inputPricePerMillion;
    cost += (roundCompletionTokens / 1_000_000) * pricing.outputPricePerMillion;

    if (cost > 0) {
      parts.push(`费用: ¥${formatCost(cost)}`);
    }
  }

  return {
    id: `summary-${Math.random().toString(36).slice(2)}`,
    sessionId: session.id,
    role: "system",
    content: parts.join(" · "),
    contentParams: null,
    messageParams: { statusColor },
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
    meta: { isSummary: true }
  };
}

function formatCost(cost: number): string {
  if (cost < 0.001) {
    return cost.toFixed(6);
  }
  if (cost < 0.01) {
    return cost.toFixed(4);
  }
  if (cost < 1) {
    return cost.toFixed(3);
  }
  if (cost < 10) {
    return cost.toFixed(2);
  }
  return cost.toFixed(1);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m${seconds}s`;
}

function buildStatusLine(entry: SessionEntry, activeModel?: string): string {
  const parts: string[] = [];
  parts.push(`status: ${entry.status}`);
  if (typeof entry.activeTokens === "number" && entry.activeTokens > 0) {
    const current = formatTokenCount(entry.activeTokens);
    if (entry.compactThreshold && entry.compactThreshold > 0) {
      const max = formatTokenCount(entry.compactThreshold);
      const pct = Math.round((entry.activeTokens / entry.compactThreshold) * 100);
      parts.push(`tokens: ${current}/${max} (${pct}%)`);
    } else {
      parts.push(`tokens: ${current}`);
    }
  }
  if (entry.failReason) {
    parts.push(`fail: ${entry.failReason}`);
  }
  if (activeModel) {
    parts.push(`model: ${activeModel}`);
  }
  return parts.join(" · ");
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
