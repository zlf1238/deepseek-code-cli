import * as crypto from "crypto";
import * as fs from "fs";

import * as path from "path";

export type FileLineEnding = "LF" | "CRLF";

export type FileState = {
  filePath: string;
  content: string;
  timestamp: number;
  offset?: number;
  limit?: number;
  isPartialView?: boolean;
  encoding?: BufferEncoding;
  lineEndings?: FileLineEnding;
};

export type FileSnippet = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  preview: string;
};

const fileStatesBySession = new Map<string, Map<string, FileState>>();
const snippetsBySession = new Map<string, Map<string, FileSnippet>>();
const snippetCountersBySession = new Map<string, number>();

export function normalizeFilePath(filePath: string): string {
  return path.normalize(filePath);
}

export function recordFileState(sessionId: string, state: FileState): void {
  if (!sessionId || !state.filePath) {
    return;
  }

  let sessionState = fileStatesBySession.get(sessionId);
  if (!sessionState) {
    sessionState = new Map<string, FileState>();
    fileStatesBySession.set(sessionId, sessionState);
  }

  const normalizedPath = normalizeFilePath(state.filePath);
  sessionState.set(normalizedPath, {
    ...state,
    filePath: normalizedPath
  });
}

export function markFileRead(
  sessionId: string,
  filePath: string,
  state: Omit<FileState, "filePath"> | null = null
): void {
  if (!sessionId || !filePath) {
    return;
  }

  recordFileState(sessionId, {
    filePath,
    content: state?.content ?? "",
    timestamp: state?.timestamp ?? 0,
    offset: state?.offset,
    limit: state?.limit,
    isPartialView: state?.isPartialView,
    encoding: state?.encoding,
    lineEndings: state?.lineEndings
  });
}

export function getFileState(sessionId: string, filePath: string): FileState | null {
  if (!sessionId || !filePath) {
    return null;
  }

  return fileStatesBySession.get(sessionId)?.get(normalizeFilePath(filePath)) ?? null;
}

export function wasFileRead(sessionId: string, filePath: string): boolean {
  return getFileState(sessionId, filePath) !== null;
}

export function isFullFileView(state: FileState | null): boolean {
  return Boolean(
    state &&
      !state.isPartialView &&
      typeof state.offset === "undefined" &&
      typeof state.limit === "undefined"
  );
}

export function createSnippet(
  sessionId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  preview: string
): FileSnippet | null {
  if (!sessionId || !filePath || startLine < 1 || endLine < startLine) {
    return null;
  }

  const nextCounter = (snippetCountersBySession.get(sessionId) ?? 0) + 1;
  snippetCountersBySession.set(sessionId, nextCounter);

  const snippet: FileSnippet = {
    id: `snippet_${nextCounter}`,
    filePath: normalizeFilePath(filePath),
    startLine,
    endLine,
    preview
  };

  let snippets = snippetsBySession.get(sessionId);
  if (!snippets) {
    snippets = new Map<string, FileSnippet>();
    snippetsBySession.set(sessionId, snippets);
  }
  snippets.set(snippet.id, snippet);
  return snippet;
}

export function getSnippet(sessionId: string, snippetId: string): FileSnippet | null {
  if (!sessionId || !snippetId) {
    return null;
  }
  return snippetsBySession.get(sessionId)?.get(snippetId) ?? null;
}

// ============================================================
// Handle 读取：按 snippet_id 从缓存中切片，自动检测文件是否过时
// ============================================================



/**
 * 检查 snippet 对应的磁盘文件是否比缓存更新。
 * 返回 true 表示需要回源重读。
 */
export function isFileStale(sessionId: string, snippet: FileSnippet): boolean {
  const fileState = getFileState(sessionId, snippet.filePath);
  if (!fileState) return true;
  try {
    const stat = fs.statSync(snippet.filePath);
    return stat.mtimeMs > fileState.timestamp;
  } catch {
    return true;
  }
}

/**
 * 按 snippet_id 从缓存切片指定行范围。
 * 做过时检测：文件已变则返回 { stale: true }。
 */
export function readSnippetLines(
  sessionId: string,
  snippetId: string,
  startLine: number,
  endLine: number
):
  | { ok: true; lines: string[]; fromLine: number; toLine: number }
  | { ok: false; stale: true; filePath: string }
  | { ok: false; error: string } {
  const snippet = getSnippet(sessionId, snippetId);
  if (!snippet) {
    return { ok: false, error: `Snippet "${snippetId}" not found in current session.` };
  }

  if (isFileStale(sessionId, snippet)) {
    return { ok: false, stale: true, filePath: snippet.filePath };
  }

  const fileState = getFileState(sessionId, snippet.filePath);
  if (!fileState || !fileState.content) {
    return { ok: false, stale: true, filePath: snippet.filePath };
  }

  const allLines = fileState.content.split("\n");
  const from = Math.max(startLine, 1);
  const to = Math.min(endLine, allLines.length);

  if (from > allLines.length) {
    return {
      ok: false,
      error: `startLine ${startLine} exceeds file length ${allLines.length}.`
    };
  }

  const lines = allLines.slice(from - 1, to);
  return { ok: true, lines, fromLine: from, toLine: to };
}

/**
 * 从会话历史消息中恢复 snippet 元数据。
 * resume session 时调用，使 handle_read 可以在重启后回源读磁盘。
 */
// ── Tool output spill storage ──────────────────────────────────────────────

export type ToolOutputHandle = {
  id: string;
  toolName: string;
  sessionId: string;
  length: number;
  preview: string;
  sha256: string;
};

const toolOutputsBySession = new Map<string, Map<string, string>>();
const toolOutputHandlesBySession = new Map<string, Map<string, ToolOutputHandle>>();

/** 将工具输出溢出存储到进程内存，返回 handle 引用。 */
export function spillToolOutput(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  fullOutput: string,
  previewChars = 160
): ToolOutputHandle {
  if (!sessionId || !toolCallId) {
    return { id: toolCallId, toolName, sessionId, length: 0, preview: "", sha256: "" };
  }

  let sessionStore = toolOutputsBySession.get(sessionId);
  if (!sessionStore) {
    sessionStore = new Map<string, string>();
    toolOutputsBySession.set(sessionId, sessionStore);
  }
  sessionStore.set(toolCallId, fullOutput);

  const preview = fullOutput.slice(0, previewChars);
  const sha256 = crypto.createHash("sha256").update(fullOutput, "utf8").digest("hex");

  const handle: ToolOutputHandle = {
    id: toolCallId,
    toolName,
    sessionId,
    length: fullOutput.length,
    preview,
    sha256,
  };

  let handleStore = toolOutputHandlesBySession.get(sessionId);
  if (!handleStore) {
    handleStore = new Map<string, ToolOutputHandle>();
    toolOutputHandlesBySession.set(sessionId, handleStore);
  }
  handleStore.set(toolCallId, handle);

  return handle;
}

/** 按 ref 获取溢出的工具输出。ref 可以是 tool_call_id 或 sha256 前缀。 */
export function getSpilledOutput(sessionId: string, ref: string): string | null {
  const sessionStore = toolOutputsBySession.get(sessionId);
  if (!sessionStore) return null;

  // 直接匹配 tool_call_id
  const direct = sessionStore.get(ref);
  if (direct !== undefined) return direct;

  // SHA256 前缀匹配
  const handleStore = toolOutputHandlesBySession.get(sessionId);
  if (handleStore) {
    for (const [, handle] of handleStore) {
      if (handle.sha256.startsWith(ref)) {
        return sessionStore.get(handle.id) ?? null;
      }
    }
  }

  return null;
}

/** 列出 session 中所有溢出的工具输出 handle。 */
export function listSpilledOutputs(sessionId: string): ToolOutputHandle[] {
  const handleStore = toolOutputHandlesBySession.get(sessionId);
  if (!handleStore) return [];
  return Array.from(handleStore.values());
}

/** 获取单个 handle 元数据。 */
export function getSpilledOutputHandle(sessionId: string, ref: string): ToolOutputHandle | null {
  const handleStore = toolOutputHandlesBySession.get(sessionId);
  if (!handleStore) return null;
  const direct = handleStore.get(ref);
  if (direct) return direct;
  for (const [, h] of handleStore) {
    if (h.sha256.startsWith(ref)) return h;
  }
  return null;
}

/** 从工具输出中查找匹配 query 的行，返回匹配行及上下文。 */
export function querySpilledOutput(
  sessionId: string,
  ref: string,
  query: string,
  contextLines = 1,
  maxMatches = 20
): { matches: Array<{ line: number; text: string; context: string[] }>; totalLines: number } | null {
  const content = getSpilledOutput(sessionId, ref);
  if (!content) return null;

  const lines = content.split("\n");
  const lowerQuery = query.toLowerCase();
  const matches: Array<{ line: number; text: string; context: string[] }> = [];

  for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
    if (lines[i]!.toLowerCase().includes(lowerQuery)) {
      const ctx: string[] = [];
      for (let j = Math.max(0, i - contextLines); j < i; j++) {
        ctx.push(lines[j]!);
      }
      matches.push({ line: i + 1, text: lines[i]!, context: ctx });
    }
  }

  return { matches, totalLines: lines.length };
}

export function restoreSnippetsFromHistory(
  sessionId: string,
  messages: Array<{ role: string; content: unknown }>
): void {
  for (const msg of messages) {
    if (msg.role !== "tool" || typeof msg.content !== "string") continue;
    try {
      const parsed = JSON.parse(msg.content) as Record<string, unknown>;
      if (parsed.ok && parsed.name === "read") {
        const meta = parsed.metadata as Record<string, unknown> | undefined;
        const snippet = meta?.snippet as Record<string, unknown> | undefined;
        if (snippet?.id && snippet?.filePath && typeof snippet.startLine === "number") {
          const existing = getSnippet(sessionId, snippet.id as string);
          if (existing) continue;
          createSnippet(
            sessionId,
            snippet.filePath as string,
            snippet.startLine as number,
            (snippet.endLine as number) ?? (snippet.startLine as number),
            (snippet.preview as string) ?? ""
          );
        }
      }
    } catch {
      /* ignore malformed */
    }
  }
}
