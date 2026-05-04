import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionEntry } from "../session";

type Props = {
  sessions: SessionEntry[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  onDelete?: (sessionIds: string[]) => void;
};

export function SessionList({ sessions, onSelect, onCancel, onDelete }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setIndex((i) => Math.min(sessions.length - 1, i + 1));
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
        }
        return;
      }
      return;
    }

    // Normal mode
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
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

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No previous sessions found.</Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color={deleteMode ? "red" : "cyanBright"}>
        {deleteMode ? "Delete sessions" : "Resume a session"}
      </Text>
      {sessions.slice(0, 30).map((session, i) => {
        const isCurrent = i === index;
        const isSelected = selectedIds.has(session.id);
        let prefix: string;
        if (deleteMode) {
          prefix = isSelected ? "\u001b[31m[x]\u001b[39m " : "[ ] ";
        } else {
          prefix = isCurrent ? "\u001b[36m›\u001b[39m " : "  ";
        }
        const color = deleteMode
          ? isSelected ? "red" : undefined
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
      {sessions.length > 30 ? <Text dimColor>… {sessions.length - 30} older sessions hidden.</Text> : null}
      <Box marginTop={1}>
        {deleteMode ? (
          <Text dimColor>
            Space select · a {selectedIds.size === sessions.length ? "deselect all" : "select all"} · Enter confirm delete ({selectedIds.size} selected) · Esc/d exit delete mode
          </Text>
        ) : (
          <Text dimColor>↑/↓ navigate · Enter select · d delete mode · Esc cancel</Text>
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
