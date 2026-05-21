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
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // 5.2 会话搜索：根据 searchQuery 过滤会话
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const title = (s.summary || "").toLowerCase();
      const status = (s.status || "").toLowerCase();
      const id = s.id.toLowerCase();
      return title.includes(q) || status.includes(q) || id.includes(q);
    });
  }, [sessions, searchQuery]);

  // Compute how many sessions fit within the terminal window.
  const maxVisible = useMemo(() => {
    const rows = stdout?.rows ?? 24;
    return Math.max(5, rows - OVERHEAD_LINES - 1);
  }, [stdout?.rows]);

  // 选中索引复位：过滤结果变化时
  const safeIndex = Math.min(index, Math.max(0, filteredSessions.length - 1));

  useInput((input, key) => {
    // ── 搜索模式 ──
    if (searchMode) {
      if (key.escape || (key.return && !input)) {
        setSearchMode(false);
        setSearchQuery("");
        return;
      }
      if (key.return) {
        // 确认搜索，切换到浏览模式
        setSearchMode(false);
        setIndex(0);
        setScrollOffset(0);
        return;
      }
      if (key.backspace) {
        setSearchQuery((prev) => prev.slice(0, -1));
        return;
      }
      if (key.delete) {
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const sanitized = input.replace(/\r/g, "");
        setSearchQuery((prev) => prev + sanitized);
        setIndex(0);
        setScrollOffset(0);
      }
      return;
    }

    // ── 全局 ──
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

    // / 键进入搜索模式
    if (input === "/" && !deleteMode && filteredSessions.length > 0) {
      setSearchMode(true);
      setSearchQuery("");
      return;
    }

    if (deleteMode) {
      if (input === "d" || input === "D") {
        setDeleteMode(false);
        setSelectedIds(new Set());
        return;
      }
      if (key.upArrow) {
        const next = Math.max(0, safeIndex - 1);
        setIndex(next);
        autoScroll(next);
        return;
      }
      if (key.downArrow) {
        const next = Math.min(filteredSessions.length - 1, safeIndex + 1);
        setIndex(next);
        autoScroll(next);
        return;
      }
      if (input === " ") {
        toggleSelection(filteredSessions, safeIndex, selectedIds, setSelectedIds);
        return;
      }
      if (input === "a" || input === "A") {
        if (selectedIds.size === filteredSessions.length) {
          setSelectedIds(new Set());
        } else {
          setSelectedIds(new Set(filteredSessions.map((s) => s.id)));
        }
        return;
      }
      if (key.return) {
        if (selectedIds.size > 0 && onDelete) {
          onDelete(Array.from(selectedIds));
        }
        setDeleteMode(false);
        setSelectedIds(new Set());
        return;
      }
      return;
    }

    // 正常浏览模式
    if (key.upArrow) {
      const next = Math.max(0, safeIndex - 1);
      setIndex(next);
      autoScroll(next);
      return;
    }

    if (key.downArrow) {
      const next = Math.min(filteredSessions.length - 1, safeIndex + 1);
      setIndex(next);
      autoScroll(next);
      return;
    }

    if (input === "d" || input === "D") {
      setDeleteMode(true);
      setSelectedIds(new Set());
      return;
    }

    if (key.return) {
      const selected = filteredSessions[safeIndex];
      if (selected) {
        onSelect(selected.id);
      }
      return;
    }
  });

  function autoScroll(newIndex: number): void {
    if (newIndex < scrollOffset) {
      setScrollOffset(newIndex);
    } else if (newIndex >= scrollOffset + maxVisible) {
      setScrollOffset(newIndex - maxVisible + 1);
    }
  }

  const visible = filteredSessions.slice(scrollOffset, scrollOffset + maxVisible);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>选择一个会话继续</Text>
      </Box>

      {/* 搜索模式提示/输入 */}
      {searchMode ? (
        <Box>
          <Text color="cyan">搜索: /</Text>
          <Text>{searchQuery}</Text>
          <Text dimColor>_</Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          {filteredSessions.length > 0 && !deleteMode ? (
            <Text dimColor>按 / 搜索</Text>
          ) : null}
        </Box>
      )}

      {filteredSessions.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>无匹配的会话</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visible.map((session, displayIdx) => {
            const sessionIndex = scrollOffset + displayIdx;
            const isCurrent = sessionIndex === safeIndex;
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
              <Text key={session.id} color={color} wrap="truncate-end">
                {prefix}
                <Text dimColor>{formatTimestamp(session.updateTime)} </Text>
                <Text>
                  {searchQuery.trim()
                    ? highlightText(formatSessionTitle(session.summary || "Untitled"), searchQuery)
                    : formatSessionTitle(session.summary || "Untitled")}
                </Text>
                <Text dimColor>  ({session.status})</Text>
              </Text>
            );
          })}
          {scrollOffset + maxVisible < filteredSessions.length ? (
            <Text dimColor wrap="truncate-end">…… 还有 {filteredSessions.length - scrollOffset - maxVisible} 个更晚的会话已隐藏</Text>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        {searchMode ? (
          <Text dimColor wrap="truncate-end">
            输入搜索关键词 · Enter 确认 · Esc 取消
          </Text>
        ) : deleteMode ? (
          <Text dimColor wrap="truncate-end">
            {selectedIds.size === filteredSessions.length
              ? "空格/a: 取消全选"
              : "空格: 切换选择 · a: 全选"}
            · Enter: 确认删除({selectedIds.size} 个) · Esc/d: 退出删除模式
          </Text>
        ) : filteredSessions.length > 0 ? (
          <Text dimColor wrap="truncate-end">↑/↓: 切换选择 · Enter: 继续该会话 · /: 搜索 · d: 进入批量删除模式 · Esc: 返回</Text>
        ) : (
          <Text dimColor wrap="truncate-end">Esc: 返回</Text>
        )}
      </Box>
    </Box>
  );
}

/** 高亮文本中匹配搜索关键词的部分 */
function highlightText(text: string, query: string): React.ReactElement {
  if (!query.trim()) return <>{text}</>;

  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactElement[] = [];
  let lastIndex = 0;

  let matchIndex = lower.indexOf(q, lastIndex);
  while (matchIndex !== -1) {
    // 匹配前的部分
    if (matchIndex > lastIndex) {
      parts.push(<React.Fragment key={`t-${lastIndex}`}>{text.slice(lastIndex, matchIndex)}</React.Fragment>);
    }
    // 匹配的部分（高亮）
    parts.push(
      <Text key={`h-${matchIndex}`} color="yellow" bold>
        {text.slice(matchIndex, matchIndex + q.length)}
      </Text>
    );
    lastIndex = matchIndex + q.length;
    matchIndex = lower.indexOf(q, lastIndex);
  }

  // 剩余部分
  if (lastIndex < text.length) {
    parts.push(<React.Fragment key={`t-${lastIndex}`}>{text.slice(lastIndex)}</React.Fragment>);
  }

  return <>{parts}</>;
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
