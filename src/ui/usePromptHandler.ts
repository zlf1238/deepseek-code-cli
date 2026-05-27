/** handlePrompt 逻辑抽取：将提交处理逻辑与 UI 渲染分离 */
import { useCallback, useRef } from "react";
import type { SessionManager, UserPromptContent, SessionMessage, SessionEntry, SkillInfo, SessionStatus, LlmStreamProgress } from "../session";
import type { PromptSubmission } from "./PromptInput";
import { buildCompletionSummary } from "./completionSummary";
import {
  getTotalTokens, getPromptTokens, getCompletionTokens,
  getPromptCacheHitTokens, getPromptCacheMissTokens,
} from "../session";
import type { PricingConfig } from "../settings";

type MessagesAction =
  | { type: "setMessages"; messages: SessionMessage[] }
  | { type: "appendMessage"; message: SessionMessage }
  | { type: "resetMessages" };

type DispatchMessages = (action: MessagesAction) => void;

export type PromptHandlerDeps = {
  sessionManager: SessionManager;
  dispatchMessages: DispatchMessages;
  setBusy: (busy: boolean) => void;
  setStatusLine: (line: string) => void;
  setErrorLine: (line: string | null) => void;
  setRunningProcesses: (p: SessionEntry["processes"] | null) => void;
  setActiveStatus: (s: SessionStatus | null) => void;
  setDismissedQuestionIds: (ids: Set<string>) => void;
  setStreamProgress: (p: LlmStreamProgress | null) => void;
  setView: (v: "chat" | "session-list") => void;
  refreshSessionsList: () => void;
  refreshSkills: (sessionId?: string) => Promise<void>;
  clearTerminal: () => void;
  exit: () => void;
  pricingRef: { current: Required<PricingConfig> };
  resolveModelPricing: (name: string) => Required<PricingConfig>;
};

/**
 * 处理用户提交的自定义 hook。
 * 将 /new、/resume、/exit 命令和普通消息提交逻辑集中管理。
 */
export function usePromptHandler(deps: PromptHandlerDeps) {
  const {
    sessionManager, dispatchMessages, setBusy, setStatusLine, setErrorLine,
    setRunningProcesses, setActiveStatus, setDismissedQuestionIds,
    setStreamProgress, setView, refreshSessionsList, refreshSkills,
    clearTerminal, exit, pricingRef, resolveModelPricing,
  } = deps;

  const isSubmittingRef = useRef(false);

  const handlePrompt = useCallback(
    async (submission: PromptSubmission) => {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;

      // ── 命令处理 ──
      if (submission.command === "exit") {
        exit();
        process.exit(0);
        return;
      }

      if (submission.command === "new") {
        sessionManager.setActiveSessionId(null);
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
        console.log("[resume-debug] HANDLE_RESUME called");
        clearTerminal();
        dispatchMessages({ type: "resetMessages" });
        setStatusLine("");
        setErrorLine(null);
        setRunningProcesses(null);
        setActiveStatus(null);
        setView("session-list");
        console.log("[resume-debug] VIEW_CHANGED_to_session-list, sessions count:", sessionManager.listSessions().length);
        refreshSessionsList();
        isSubmittingRef.current = false;
        console.log("[resume-debug] HANDLE_RESUME done");
        return;
      }

      // ── 普通消息提交 ──
      const prompt: UserPromptContent = {
        text: submission.text,
        imageUrls: submission.imageUrls,
        skills: submission.selectedSkills && submission.selectedSkills.length > 0
          ? submission.selectedSkills
          : undefined,
      };

      const trimmedText = (submission.text ?? "").trim();
      const selectedSkillNames = submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ?? [];
      const userDisplayContent = trimmedText
        || (selectedSkillNames.length > 0 ? `Use skills: ${selectedSkillNames.join(", ")}` : "")
        || (submission.imageUrls.length > 0 ? "[Image]" : "");

      dispatchMessages({
        type: "appendMessage",
        message: buildSyntheticUserMessage(userDisplayContent, submission.imageUrls.length),
      });

      setBusy(true);
      setErrorLine(null);
      setDismissedQuestionIds(new Set());

      // 记录提交前的 token 用量快照（用于计算本轮增量）
      const activeSessionIdBefore = sessionManager.getActiveSessionId();
      const sessionBefore = activeSessionIdBefore ? sessionManager.getSession(activeSessionIdBefore) : null;
      const totalTokensBefore = sessionBefore ? getTotalTokens(sessionBefore.usage) : 0;
      const promptTokensBefore = sessionBefore ? getPromptTokens(sessionBefore.usage) : 0;
      const completionTokensBefore = sessionBefore ? getCompletionTokens(sessionBefore.usage) : 0;
      const cacheHitBefore = sessionBefore ? getPromptCacheHitTokens(sessionBefore.usage) : 0;
      const cacheMissBefore = sessionBefore ? getPromptCacheMissTokens(sessionBefore.usage) : 0;
      const usageByModelBefore: Record<string, Record<string, number>> = {};
      const rawBefore = sessionBefore?.usageByModel;
      if (rawBefore && typeof rawBefore === "object" && !Array.isArray(rawBefore)) {
        const usageByModel = rawBefore as Record<string, Record<string, number>>;
        for (const [mn, mu] of Object.entries(usageByModel)) {
          if (mu && typeof mu === "object" && !Array.isArray(mu)) {
            usageByModelBefore[mn] = { ...mu };
          }
        }
      }
      const startedAt = Date.now();

      try {
        await sessionManager.handleUserPrompt(prompt);

        // 计算本轮 token 增量并生成摘要
        const elapsedMs = Date.now() - startedAt;
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
              usageByModelDiff, resolveModelPricing,
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
    [
      sessionManager, dispatchMessages, setBusy, setStatusLine, setErrorLine,
      setRunningProcesses, setActiveStatus, setDismissedQuestionIds,
      setStreamProgress, setView, refreshSessionsList, refreshSkills,
      clearTerminal, exit, pricingRef, resolveModelPricing,
    ],
  );

  return { handlePrompt, isSubmittingRef };
}

// ═══════════════════════════════════════════════════════════════════════════
// 内联辅助函数
// ═══════════════════════════════════════════════════════════════════════════

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
            type: "image_url" as const,
            image_url: { url: "" },
          }))
        : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}
