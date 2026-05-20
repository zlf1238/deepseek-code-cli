import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionMessage } from "../session";

export type ThinkingExpandedState = {
  /** Toggle a specific thinking message between expanded and collapsed */
  toggle: (id: string) => void;
  /** Expand all thinking messages */
  expandAll: () => void;
  /** Collapse all thinking messages */
  collapseAll: () => void;
  /** Check if a specific thinking message is currently expanded */
  isExpanded: (id: string) => boolean;
  /** The message ID of the latest thinking message (auto-expanded by default) */
  latestThinkingId: string | null;
  /** Total number of thinking messages in the conversation */
  thinkingCount: number;
  /** Array of thinking message IDs */
  thinkingIds: string[];
};

/**
 * Manages which thinking blocks are expanded/collapsed in the UI.
 * By default, only the latest thinking message is auto-expanded;
 * all previous thinking messages start collapsed.
 */
export function useThinkingExpanded(
  messages: SessionMessage[],
  defaultExpanded: "latest" | "none" | "all" = "latest"
): ThinkingExpandedState {
  // Collect all thinking message IDs (stable reference via useMemo)
  const thinkingIds = useMemo(() => {
    return messages
      .filter(
        (m) =>
          m.role === "assistant" &&
          m.meta?.asThinking &&
          m.visible !== false
      )
      .map((m) => m.id);
  }, [messages]);

  const latestThinkingId =
    thinkingIds.length > 0 ? thinkingIds[thinkingIds.length - 1] : null;

  // Initialize with default expansion state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    if (defaultExpanded === "latest" && latestThinkingId) {
      return new Set([latestThinkingId]);
    }
    if (defaultExpanded === "all") {
      return new Set(thinkingIds);
    }
    return new Set();
  });

  // Auto-expand newly arrived thinking messages (streaming scenario)
  const prevLatestRef = useRef<string | null>(latestThinkingId);
  useEffect(() => {
    if (
      defaultExpanded === "latest" &&
      latestThinkingId &&
      latestThinkingId !== prevLatestRef.current
    ) {
      setExpandedIds((prev) => {
        if (prev.has(latestThinkingId)) return prev;
        const next = new Set(prev);
        next.add(latestThinkingId);
        return next;
      });
    }
    prevLatestRef.current = latestThinkingId;
  }, [latestThinkingId, defaultExpanded]);

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(thinkingIds));
  }, [thinkingIds]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set());
  }, [thinkingIds]);

  const isExpanded = useCallback(
    (id: string) => expandedIds.has(id),
    [expandedIds]
  );

  return {
    toggle,
    expandAll,
    collapseAll,
    isExpanded,
    latestThinkingId,
    thinkingCount: thinkingIds.length,
    thinkingIds,
  };
}
