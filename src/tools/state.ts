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
