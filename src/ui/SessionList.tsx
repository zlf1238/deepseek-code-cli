import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { SessionEntry } from "../session";

type Props = {
  sessions: SessionEntry[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  onDelete?: (sessionIds: string[]) => void;
};

/**
 * Fixed overhead lines in the SessionList layout:
 *   1  title line ("选择一个会话继续")
 *   1  hidden-notice line (conditional)
 *   1  marginTop spacer (from the instruction <Box>)
 *   1  instruction line
 *  ----
 *   4  total fixed lines
 */
const OVERHEAD_LINES = 4;

export function SessionList({ sessions, onSelect, onCancel, onDelete }: Props): React.ReactElement {
  const { stdout } = useStdout();
  const [index, setIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Compute how many sessions fit within the terminal window.
  const maxVisible = useMemo(() => {
    const rows = stdout?.rows ?? 24;
    // Reserve overhead lines + 1 safety line so the list never overflows
    return Math.max(5, rows - OVERHEAD_LINES - 1);
  }, [stdout?.rows]);

  useInput((input, key) => {
    // Global: Esc always cancels delete mode first, then cancels the view
    if (key.escape) {
      if (deleteMode) {
        setDeleteMode(false);
        setSelectedIds(new Set());
        return;
      }
      onCancel();
      return;
    }

    if (key.ctrl && (input === "c" || input === "C")) {
      onCancel();
      return;
    }

    if (deleteMode) {
      if (input === "d" || input === "D") {
        setDeleteMode(false);
        setSelectedIds(new Set());
        return;
      }
      if (key.upArrow) {
        const next = Math.max(0, index - 1);
        setIndex(next);
        autoScroll(next);
        return;
      }
      if (key.downArrow) {
        const next = Math.min(sessions.length - 1, index + 1);
        setIndex(next);
        autoScroll(next);
        return;
      }
      if (input === " ") {
        toggleSelection(sessions, index, selectedIds, setSelectedIds);
        return;
      }
      if (input === "a" || input === "A") {
        if (selectedIds.size === sessions.length) {
          setSelectedIds(new Set());
        } else {
          setSelectedIds(new Set(sessions.map((s) => s.id)));
        }
        return;
      }
      if (key.return) {
        const ids = Array.from(selectedIds);
        if (ids.length > 0) {
          onDelete?.(ids);
          setDeleteMode(false);
          setSelectedIds(new Set());
          setIndex(0);
          setScrollOffset(0);
        }
        return;
      }
      return;
    }

    // Normal mode
    if (key.upArrow) {
      const next = Math.max(0, index - 1);
      setIndex(next);
      autoScroll(next);
      return;
    }
    if (key.downArrow) {
      const next = Math.min(sessions.length - 1, index + 1);
      setIndex(next);
      autoScroll(next);
      return;
    }
    if (key.return) {
      const session = sessions[index];
      if (session) {
        onSelect(session.id);
      }
      return;
    }
    if (input === "d" || input === "D") {
      setDeleteMode(true);
      setSelectedIds(new Set());
      return;
    }
  });

  function autoScroll(targetIndex: number): void {
    setScrollOffset((current) => {
      if (targetIndex < current) {
        return targetIndex;
      }
      if (targetIndex >= current + maxVisible) {
        return targetIndex - maxVisible + 1;
      }
      return current;
    });
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">暂无历史会话。</Text>
        <Text dimColor>按 Esc 返回。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color={deleteMode ? "red" : "cyanBright"}>
        {deleteMode ? "删除会话" : "选择一个会话继续"}
      </Text>
      {scrollOffset > 0 ? (
        <Text dimColor>…… {scrollOffset} 个更早的会话已隐藏</Text>
      ) : null}
      {sessions.slice(scrollOffset, scrollOffset + maxVisible).map((session, i) => {
        const sessionIndex = scrollOffset + i;
        const isCurrent = sessionIndex === index;
        const isSelected = selectedIds.has(session.id);
        let prefix: string;
        if (deleteMode) {
          const pos = isCurrent ? "\u001b[36m›\u001b[39m " : "  ";
          const check = isSelected ? "\u001b[31m[x]\u001b[39m" : "[ ]";
          prefix = pos + check + " ";
        } else {
          prefix = isCurrent ? "\u001b[36m›\u001b[39m " : "  ";
        }
        const color = deleteMode
          ? isSelected ? "red" : isCurrent ? "cyanBright" : undefined
          : isCurrent ? "cyanBright" : undefined;

        return (
          <Text key={session.id} color={color}>
            {prefix}
            <Text dimColor>{formatTimestamp(session.updateTime)} </Text>
            <Text>{formatSessionTitle(session.summary || "Untitled")}</Text>
            <Text dimColor>  ({session.status})</Text>
          </Text>
        );
      })}
      {scrollOffset + maxVisible < sessions.length ? (
        <Text dimColor>…… 还有 {sessions.length - scrollOffset - maxVisible} 个更晚的会话已隐藏</Text>
      ) : null}
      <Box marginTop={1}>
        {deleteMode ? (
          <Text dimColor>
            {selectedIds.size === sessions.length
              ? "空格/a: 取消全选"
              : "空格: 切换选择 · a: 全选"}
            · Enter: 确认删除({selectedIds.size} 个) · Esc/d: 退出删除模式
          </Text>
        ) : (
          <Text dimColor>↑/↓: 切换选择 · Enter: 继续该会话 · d: 进入批量删除模式 · Esc: 返回</Text>
        )}
      </Box>
    </Box>
  );
}

function toggleSelection(
  sessions: SessionEntry[],
  index: number,
  selectedIds: Set<string>,
  setSelectedIds: (ids: Set<string>) => void
): void {
  const id = sessions[index]?.id;
  if (!id) return;
  const next = new Set(selectedIds);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  setSelectedIds(next);
}

function formatTimestamp(value: string): string {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
      return value;
    }
    return date.toLocaleString();
  } catch {
    return value;
  }
}

export function formatSessionTitle(value: string, max = 70): string {
  return truncate(value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim(), max);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}
