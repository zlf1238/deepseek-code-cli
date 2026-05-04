import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout } from "ink";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import {
  SessionManager,
  getTotalTokens,
  type LlmStreamProgress,
  type SessionEntry,
  type SessionMessage,
  type SessionStatus,
  type SkillInfo,
  type UserPromptContent
} from "../session";
import { resolveSettings, getAvailableModelNames, updateActiveModelInSettings, type DeepcodingSettings } from "../settings";
import { PromptInput, type PromptSubmission } from "./PromptInput";
import { MessageView } from "./MessageView";
import { SessionList } from "./SessionList";
import { buildLoadingText } from "./loadingText";
import { findExpandedThinkingId } from "./thinkingState";
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
// Used by `/new` and session-switch to clear stale Static output from the terminal.
const directTerminalWrite = process.stdout.write.bind(process.stdout);

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

  const messagesRef = useRef<SessionMessage[]>([]);
  messagesRef.current = messages;
  const activeModelRef = useRef(activeModel);
  activeModelRef.current = activeModel;

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
    return manager.listSessionMessages(sessionId).filter((m) => m.visible);
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
        directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
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
        // Clear screen before switching views to avoid stale Ink output artifacts
        directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
        refreshSessionsList();
        setView("session-list");
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
      setBusy(true);
      setErrorLine(null);
      setRunningProcesses(null);
      try {
        await sessionManager.handleUserPrompt(prompt);
        // Append a completion summary with elapsed time and token usage
        const elapsedMs = Date.now() - promptStartTimeRef.current;
        const activeSessionId = sessionManager.getActiveSessionId();
        if (activeSessionId) {
          const session = sessionManager.getSession(activeSessionId);
          if (session) {
            const summaryMessage = buildCompletionSummary(session, elapsedMs);
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
      // Clear screen before loading new messages — old Static output persists otherwise.
      directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
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
  const expandedThinkingId = findExpandedThinkingId(messages);
  const pendingQuestion = useMemo(
    () => findPendingAskUserQuestion(messages, activeStatus),
    [activeStatus, messages]
  );
  const shouldShowQuestionPrompt = Boolean(
    pendingQuestion && !dismissedQuestionIds.has(pendingQuestion.messageId)
  );
  // Recalculated every render so the elapsed-time counter ticks in real time.
  const loadingText = busy
    ? buildLoadingText({ progress: streamProgress, processes: runningProcesses, now: Date.now() })
    : null;

  // Dynamic settings: re-resolve when activeModel changes (model persisting to disk
  // means resolveCurrentSettings picks up the new model + its per-model overrides)
  const welcomeSettings = useMemo(() => resolveCurrentSettings(), [activeModel]);

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
      <Static key={`messages-${staticKey}`} items={messages}>
        {(message) => (
          <MessageView
            key={message.id}
            message={message}
            collapsed={isCollapsedThinking(message, expandedThinkingId)}
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
            directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
            setView("chat");
          }}
          onDelete={(ids) => {
            sessionManager.removeSessions(ids);
            dispatchMessages({ type: "resetMessages" });
            setStatusLine("");
            setActiveStatus(null);
            setView("chat");
            refreshSessionsList();
            directTerminalWrite("\u001B[2J\u001B[3J\u001B[H");
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

function isCollapsedThinking(message: SessionMessage, expandedId: string | null): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (!message.meta?.asThinking) {
    return false;
  }
  return message.id !== expandedId;
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

export function buildCompletionSummary(session: SessionEntry, elapsedMs: number): SessionMessage {
  const now = new Date().toISOString();
  const elapsed = formatElapsed(elapsedMs);
  const totalTokens = getTotalTokens(session.usage);
  const tokenStr = formatTokenCount(totalTokens);

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
  parts.push(`⏱ ${elapsed}`);
  if (totalTokens > 0) {
    parts.push(`token: ${tokenStr}`);
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
} {
  const settings = overrideModel
    ? (() => {
        const raw = readSettings();
        // Remove env.MODEL so resolveSettings uses the override
        if (raw?.env) { raw.env.MODEL = undefined; }
        return resolveSettings(raw, { model: overrideModel, baseURL: DEFAULT_BASE_URL });
      })()
    : resolveCurrentSettings();
  if (!settings.apiKey) {
    return {
      client: null,
      model: settings.model,
      baseURL: settings.baseURL,
      thinkingEnabled: settings.thinkingEnabled,
      reasoningEffort: settings.reasoningEffort,
      notify: settings.notify,
      webSearchTool: settings.webSearchTool,
      machineId: getMachineId()
    };
  }

  const client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined
  });
  return {
    client,
    model: settings.model,
    baseURL: settings.baseURL,
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    notify: settings.notify,
    webSearchTool: settings.webSearchTool,
    machineId: getMachineId()
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
