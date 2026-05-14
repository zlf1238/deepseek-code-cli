import * as fs from "fs";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { readSnippetLines, getSnippet } from "./state";

const MAX_LINE_LENGTH = 2000;
const LINE_NUMBER_WIDTH = 6;

function parseLinesArg(raw: unknown): { start: number; end: number } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: 'Missing required "lines" parameter, e.g. "100-200" or "100-".' };
  }
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d+)(-(\d*))?$/);
  if (!match) {
    return {
      error: `Invalid lines format "${trimmed}". Use "START-END" (e.g. "100-200") or "START-" (e.g. "100-").`
    };
  }
  const start = parseInt(match[1]!, 10);
  const end =
    match[3] !== undefined && match[3] !== ""
      ? parseInt(match[3], 10)
      : start + 199; // 默认 200 行窗口
  if (end < start) {
    return { error: `end line (${end}) must be >= start line (${start}).` };
  }
  return { start, end };
}

function formatWithLineNumbers(lines: string[], startLineNumber: number): string {
  return lines
    .map((line, index) => {
      const lineNumber = startLineNumber + index;
      const trimmedLine =
        line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
      return `${String(lineNumber).padStart(LINE_NUMBER_WIDTH, " ")}\t${trimmedLine}`;
    })
    .join("\n");
}

export async function handleHandleReadTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const snippetId = typeof args.snippet_id === "string" ? args.snippet_id.trim() : "";
  if (!snippetId) {
    return { ok: false, name: "handle_read", error: 'Missing required "snippet_id" string.' };
  }

  const parsedLines = parseLinesArg(args.lines);

  if ("error" in parsedLines) {
    return { ok: false, name: "handle_read", error: parsedLines.error };
  }

  const { start, end } = parsedLines;
  const result = readSnippetLines(context.sessionId, snippetId, start, end);

  // 文件已变更 → 自动回源读磁盘
  if (!result.ok && "stale" in result && result.stale) {
    try {
      const raw = fs.readFileSync(result.filePath, "utf8");
      const allLines = raw.split("\n");
      const from = Math.max(start, 1);
      const to = Math.min(end, allLines.length);
      const sliced = allLines.slice(from - 1, to);
      const formatted = formatWithLineNumbers(sliced, from);

      return {
        ok: true,
        name: "handle_read",
        output: formatted,
        metadata: {
          snippet_id: snippetId,
          file_path: result.filePath,
          lines: `${from}-${to}`,
          from_cache: false,
          note: "File was modified since last Read; auto-re-sliced from filesystem."
        }
      };
    } catch (e) {
      return {
        ok: false,
        name: "handle_read",
        error: `File ${result.filePath} was modified. Auto-re-read failed: ${e instanceof Error ? e.message : String(e)}`
      };
    }
  }

  if (!result.ok) {
    return { ok: false, name: "handle_read", error: "error" in result ? result.error : `File stale: ${result.filePath}` };
  }

  const formatted = formatWithLineNumbers(result.lines, result.fromLine);

  return {
    ok: true,
    name: "handle_read",
    output: formatted,
    metadata: {
      snippet_id: snippetId,
      lines: `${result.fromLine}-${result.toLine}`,
      from_cache: true
    }
  };
}
