import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import {
  getSpilledOutput,
  getSpilledOutputHandle,
  querySpilledOutput,
  listSpilledOutputs,
  type ToolOutputHandle,
} from "./state";

const DEFAULT_MAX_BYTES = 8 * 1024;
const HARD_MAX_BYTES = 128 * 1024;
const DEFAULT_LINE_COUNT = 40;
const HARD_LINE_COUNT = 500;
const DEFAULT_MAX_MATCHES = 20;
const HARD_MAX_MATCHES = 100;
const DEFAULT_CONTEXT_LINES = 1;
const HARD_CONTEXT_LINES = 5;

function resolveRef(
  ref: string,
  sessionId: string
): { content: string; handle: ToolOutputHandle } | { error: string } {
  // 1. 直接 tool_call_id 匹配
  const direct = getSpilledOutput(sessionId, ref);
  const directHandle = getSpilledOutputHandle(sessionId, ref);
  if (direct && directHandle) {
    return { content: direct, handle: directHandle };
  }

  // 2. SHA256 前缀匹配
  if (ref.startsWith("sha:") || /^[0-9a-f]{64}$/i.test(ref)) {
    const shaRef = ref.startsWith("sha:") ? ref.slice(4) : ref;
    const shaContent = getSpilledOutput(sessionId, shaRef);
    const shaHandle = getSpilledOutputHandle(sessionId, shaRef);
    if (shaContent && shaHandle) {
      return { content: shaContent, handle: shaHandle };
    }
  }

  // 3. 文件名匹配（call_abc123.txt 或 artifacts/art_call_abc123.txt）
  if (ref.includes(".") || ref.includes("/")) {
    const baseName = path.basename(ref, path.extname(ref));
    const baseContent = getSpilledOutput(sessionId, baseName);
    const baseHandle = getSpilledOutputHandle(sessionId, baseName);
    if (baseContent && baseHandle) {
      return { content: baseContent, handle: baseHandle };
    }
  }

  // 4. 绝对路径到 ~/.deepseek-code/tool_outputs/
  if (path.isAbsolute(ref) && ref.includes(".deepseek-code")) {
    try {
      if (fs.existsSync(ref)) {
        const stat = fs.statSync(ref);
        if (stat.isFile() && stat.size <= HARD_MAX_BYTES) {
          const diskContent = fs.readFileSync(ref, "utf8");
          return {
            content: diskContent,
            handle: {
              id: path.basename(ref, path.extname(ref)),
              toolName: "unknown",
              sessionId,
              length: diskContent.length,
              preview: diskContent.slice(0, 160),
              sha256: "",
            },
          };
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 5. 列出所有可用的 handle
  const allHandles = listSpilledOutputs(sessionId);
  if (allHandles.length === 0) {
    return { error: `No spilled outputs found. Ref "${ref}" did not match any stored output.` };
  }
  const available = allHandles
    .map((h) => `- ${h.id} (${h.toolName}, ${h.length} chars, sha:${h.sha256.slice(0, 8)}...)`)
    .join("\n");
  return {
    error: `Ref "${ref}" not found. Available spilled outputs:\n${available}\nUse one of the IDs above, a SHA256 prefix, or the full sha256 hash.`,
  };
}

export async function handleRetrieveToolResultTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  if (!ref) {
    // 无 ref → 列出所有可用的溢出输出
    const handles = listSpilledOutputs(context.sessionId);
    if (handles.length === 0) {
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: "(no spilled tool outputs in current session)",
        metadata: { count: 0 },
      };
    }
    const listing = handles
      .map(
        (h) =>
          `- id: ${h.id}\n  tool: ${h.toolName}\n  length: ${h.length} chars\n  preview: ${h.preview.slice(0, 80)}...\n  sha256: ${h.sha256}`
      )
      .join("\n\n");
    return {
      ok: true,
      name: "retrieve_tool_result",
      output: `Available spilled tool outputs (${handles.length}):\n\n${listing}`,
      metadata: { count: handles.length },
    };
  }

  const resolved = resolveRef(ref, context.sessionId);
  if ("error" in resolved) {
    return { ok: false, name: "retrieve_tool_result", error: resolved.error };
  }

  const { content, handle } = resolved;
  const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "summary";
  const lines = content.split("\n");

  switch (mode) {
    case "summary": {
      const maxBytes =
        typeof args.max_bytes === "number" && args.max_bytes > 0
          ? Math.min(args.max_bytes, HARD_MAX_BYTES)
          : DEFAULT_MAX_BYTES;
      const head = lines.slice(0, DEFAULT_LINE_COUNT).join("\n");
      const tail = lines.slice(-DEFAULT_LINE_COUNT).join("\n");
      const middle = lines.length > DEFAULT_LINE_COUNT * 2
        ? `\n… (${lines.length - DEFAULT_LINE_COUNT * 2} lines omitted) …\n`
        : "";
      let summary = `${head}${middle}${tail}`;
      if (summary.length > maxBytes) {
        summary = summary.slice(0, maxBytes) + `\n… (truncated to ${maxBytes} bytes)`;
      }
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: summary,
        metadata: {
          handle: { id: handle.id, toolName: handle.toolName, length: handle.length },
          totalLines: lines.length,
          mode: "summary",
        },
      };
    }

    case "head": {
      const lineCount =
        typeof args.lines === "number" && args.lines > 0
          ? Math.min(args.lines, HARD_LINE_COUNT)
          : DEFAULT_LINE_COUNT;
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: lines.slice(0, lineCount).join("\n"),
        metadata: {
          handle: { id: handle.id, toolName: handle.toolName, length: handle.length },
          totalLines: lines.length,
          mode: "head",
          displayedLines: Math.min(lineCount, lines.length),
        },
      };
    }

    case "tail": {
      const lineCount =
        typeof args.lines === "number" && args.lines > 0
          ? Math.min(args.lines, HARD_LINE_COUNT)
          : DEFAULT_LINE_COUNT;
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: lines.slice(-lineCount).join("\n"),
        metadata: {
          handle: { id: handle.id, toolName: handle.toolName, length: handle.length },
          totalLines: lines.length,
          mode: "tail",
          displayedLines: Math.min(lineCount, lines.length),
        },
      };
    }

    case "lines": {
      const linesArg = typeof args.lines === "string" ? args.lines.trim() : "";
      const match = linesArg.match(/^(\d+)(-(\d*))?$/);
      if (!match) {
        return {
          ok: false,
          name: "retrieve_tool_result",
          error: `Invalid lines format "${linesArg}". Use "START-END" (e.g. "100-200") or "START-" (e.g. "100-").`,
        };
      }
      const start = parseInt(match[1]!, 10);
      const end =
        match[3] !== undefined && match[3] !== ""
          ? parseInt(match[3], 10)
          : start + DEFAULT_LINE_COUNT - 1;
      if (end < start) {
        return {
          ok: false,
          name: "retrieve_tool_result",
          error: `end line (${end}) must be >= start line (${start}).`,
        };
      }
      const from = Math.max(start, 1);
      const to = Math.min(end, lines.length);
      if (from > lines.length) {
        return {
          ok: false,
          name: "retrieve_tool_result",
          error: `start line ${start} exceeds total lines ${lines.length}.`,
        };
      }
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: lines.slice(from - 1, to).join("\n"),
        metadata: {
          handle: { id: handle.id, toolName: handle.toolName, length: handle.length },
          totalLines: lines.length,
          mode: "lines",
          displayedRange: `${from}-${to}`,
        },
      };
    }

    case "query": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return { ok: false, name: "retrieve_tool_result", error: 'Missing "query" string when mode=query.' };
      }
      const contextLines =
        typeof args.context === "number" && args.context >= 0
          ? Math.min(args.context, HARD_CONTEXT_LINES)
          : DEFAULT_CONTEXT_LINES;
      const maxMatches =
        typeof args.max_matches === "number" && args.max_matches > 0
          ? Math.min(args.max_matches, HARD_MAX_MATCHES)
          : DEFAULT_MAX_MATCHES;
      const result = querySpilledOutput(context.sessionId, ref, query, contextLines, maxMatches);
      if (!result) {
        return { ok: false, name: "retrieve_tool_result", error: `Could not retrieve output for ref "${ref}".` };
      }
      if (result.matches.length === 0) {
        return {
          ok: true,
          name: "retrieve_tool_result",
          output: `No matches for "${query}" in output (${result.totalLines} lines total).`,
          metadata: { matchCount: 0, totalLines: result.totalLines, mode: "query", query },
        };
      }
      const formatted = result.matches
        .map((m) => {
          const ctx = m.context.length > 0 ? m.context.map((l) => `  ${l}`).join("\n") + "\n" : "";
          return `${ctx}L${m.line}: ${m.text}`;
        })
        .join("\n---\n");
      return {
        ok: true,
        name: "retrieve_tool_result",
        output: `Found ${result.matches.length} matches for "${query}" in ${result.totalLines} lines:\n\n${formatted}`,
        metadata: {
          matchCount: result.matches.length,
          totalLines: result.totalLines,
          mode: "query",
          query,
        },
      };
    }

    default:
      return {
        ok: false,
        name: "retrieve_tool_result",
        error: `Unknown mode "${mode}". Supported modes: summary, head, tail, lines, query.`,
      };
  }
}
