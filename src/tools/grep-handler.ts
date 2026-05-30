import { spawn } from "child_process";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { spillToolOutput, type ToolOutputHandle } from "./state";

const MAX_OUTPUT_CHARS = 30000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;

/** 匹配超过此数量时启用 handle 化：返回预览 + handle 引用 */
const GREP_HANDLE_THRESHOLD = 100;
/** handle 化时预览的匹配条数 */
const GREP_PREVIEW_COUNT = 40;

type GrepMatch = {
  file: string;
  line: number;
  content: string;
  before: {line: number; content: string}[];
  after: {line: number; content: string}[];
};

function resolveSearchDir(root: string, targetPath: string | undefined): string {
  if (!targetPath || !targetPath.trim()) {
    return root;
  }
  const resolved = path.resolve(root, targetPath);
  if (!resolved.startsWith(root)) {
    return root;
  }
  return resolved;
}

function buildGrepArgs(
  pattern: string,
  dir: string,
  include: string | undefined,
  context: number,
  ignoreCase: boolean,
  filesWithMatches: boolean
): string[] {
  // rg 默认递归、管道无色，只需 -n (行号) + --no-heading (兼容 grep 格式)
  const args: string[] = ["-n", "--no-heading"];

  if (filesWithMatches) {
    args.push("-l");  // 只输出文件名，不需要上下文
  } else {
    args.push("-C", String(context));
  }

  if (ignoreCase) {
    args.push("-i");
  }

  if (include && include.trim()) {
    for (const inc of include.split(",").map((s) => s.trim()).filter(Boolean)) {
      args.push("-g", inc);  // rg 使用 -g (glob) 而非 --include
    }
  }

  // -- 防止 pattern 含 - 被误解析为参数
  // Windows 上 rg 对反斜杠路径处理有问题，转为正斜杠
  const searchDir = process.platform === "win32" ? dir.replace(/\\/g, "/") : dir;
  args.push("--", pattern, searchDir);
  return args;
}

function parseGrepOutput(stdout: string, context: number): GrepMatch[] {
  if (!stdout.trim()) {
    return [];
  }

  const lines = stdout.split("\n");
  const matches: GrepMatch[] = [];
  let currentMatch: GrepMatch | null = null;
  let afterCount = 0;
  let orphanBefore: Array<{line: number; content: string}> = [];

  for (const rawLine of lines) {
    // Match lines like: file:line:content  or  file-line-content (with -C)
    // grep -rn:  file:line:content
    // grep -rn -C: separator is "--", matched line has ":", context lines have "-"
    if (rawLine === "--") {
      // Flush current match
      if (currentMatch) {
        matches.push(currentMatch);
        currentMatch = null;
        afterCount = 0;
      }
      continue;
    }

    const matchColon = rawLine.match(/^([^:]+):(\d+):(.*)$/);
        // Use lazy .*? instead of [^-]+ to handle paths containing hyphens
    // (e.g. deepseek-code-cli/src/...). The filename from context lines is
    // never used — it comes from currentMatch.file — so we only need to
    // extract the line number and content.
    const matchHyphen = rawLine.match(/^.*?-(\d+)-(.*)$/);

    if (matchColon) {
      // This is the matched line
      // Flush previous match if any
      if (currentMatch) {
        matches.push(currentMatch);
        currentMatch = null;
        afterCount = 0;
      }

      currentMatch = {
        file: matchColon[1],
        line: parseInt(matchColon[2], 10),
        content: matchColon[3],
        before: [],
        after: []
      };
      // Transfer orphan before lines to current match
      for (const ob of orphanBefore) {
        if (ob.line < currentMatch.line) {
          currentMatch.before.push(ob);
        }
      }
      orphanBefore = [];
    } else if (matchHyphen && currentMatch) {
      // This is a context line
            const lineContent = matchHyphen[2];
      if (afterCount < context) {
        // Could be before or after - we determine by line number
                const lineNum = parseInt(matchHyphen[1], 10);
        if (lineNum < currentMatch.line) {
          currentMatch.before.push({line: lineNum, content: lineContent});
        } else {
          currentMatch.after.push({line: lineNum, content: lineContent});
          afterCount++;
        }
      }
    } else if (matchHyphen) {
      // Context line without current match — stash as orphan before
      orphanBefore.push({ line: parseInt(matchHyphen[1], 10), content: matchHyphen[2] });
    }
  }

  // Flush last match
  if (currentMatch) {
    matches.push(currentMatch);
  }

  return matches;
}

function formatGrepResult(matches: GrepMatch[]): string {
  if (matches.length === 0) {
    return "(no matches)";
  }

  const result: string[] = [];
  for (const match of matches) {
    for (const beforeLine of match.before) {
      result.push(`${match.file}-${match.line - match.before.indexOf(beforeLine) - 1}-${beforeLine}`);
    }
    result.push(`${match.file}:${match.line}:${match.content}`);
    for (const afterLine of match.after) {
      result.push(`${match.file}-${match.line + match.after.indexOf(afterLine) + 1}-${afterLine}`);
    }
    result.push("--");
  }

  return result.join("\n");
}

function appendChunk(existing: string, chunk: string | Buffer): string {
  if (existing.length >= MAX_CAPTURE_CHARS) {
    return existing;
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const remaining = MAX_CAPTURE_CHARS - existing.length;
  return `${existing}${text.slice(0, remaining)}`;
}

function truncateOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return { text: output, truncated: false };
  }
  return { text: output.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

interface GrepResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Run grep and return stdout/stderr/exitCode. */
async function runGrep(
  command: string,
  args: string[],
  cwd: string
): Promise<GrepResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let errorOut = "";

    child.stdout?.on("data", (chunk) => {
      output = appendChunk(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      errorOut = appendChunk(errorOut, chunk);
    });

    child.on("close", (code) => {
      resolve({
        stdout: output,
        stderr: errorOut,
        exitCode: typeof code === "number" ? code : null
      });
    });

    child.on("error", () => {
      resolve({
        stdout: output,
        stderr: errorOut,
        exitCode: null
      });
    });
  });
}


export async function handleGrepTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) {
    return {
      ok: false,
      name: "grep",
      error: "Missing required \"pattern\" string."
    };
  }

  const searchPath = typeof args.path === "string" ? args.path : undefined;
  const include = typeof args.include === "string" ? args.include : undefined;
  const contextLines = typeof args.context === "number" && args.context >= 0 ? args.context : 2;
  const ignoreCase = typeof args.ignoreCase === "boolean" ? args.ignoreCase : false;
  const outputMode = typeof args.outputMode === "string" ? args.outputMode : "content";
  const filesWithMatches = outputMode === "files_with_matches";

  const dir = resolveSearchDir(context.projectRoot, searchPath);

  let includePattern: string | undefined;
  if (typeof args.include === "string" && args.include.trim()) {
    includePattern = args.include.trim();
  }

  const grepArgs = buildGrepArgs(pattern, dir, includePattern, contextLines, ignoreCase, filesWithMatches);

  let result = await runGrep("rg", grepArgs, context.projectRoot);
  if (result.exitCode === null) {
    return {
      ok: false,
      name: "grep",
      error: "ripgrep (rg) 未安装。请安装：winget install BurntSushi.ripgrep (Windows) 或 brew install ripgrep (macOS) 或 apt install ripgrep (Linux)。"
    };
  }
  let stdout = result.stdout;
  let stderr = result.stderr;
  let exitCode = result.exitCode;

  // rg/grep exit code 1 = no matches - not an error
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    return {
      ok: false,
      name: "grep",
      error: stderr || `search failed with exit code ${exitCode}.`,
      metadata: { exitCode }
    };
  }

  let matches = parseGrepOutput(stdout, contextLines);


  const formatted = formatGrepResult(matches);

  // 匹配数超过阈值 → handle 化：溢出全量，返回预览
  if (matches.length > GREP_HANDLE_THRESHOLD) {
    const previewMatches = matches.slice(0, GREP_PREVIEW_COUNT);
    const previewText = formatGrepResult(previewMatches);
    const moreCount = matches.length - GREP_PREVIEW_COUNT;

    const handle = spillToolOutput(
      context.sessionId,
      context.toolCall.id,
      "grep",
      formatted
    );

    const output = `${previewText}

... (${moreCount} more matches not shown, ${matches.length} total)
Use retrieve_tool_result(ref="${handle.id}", mode="lines", lines="X-Y") or retrieve_tool_result(ref="${handle.id}", mode="query", query="substring") to fetch the remaining matches.
Handle sha256: ${handle.sha256.slice(0, 16)}...`;

    return {
      ok: true,
      name: "grep",
      output,
      metadata: {
        matchCount: matches.length,
        previewCount: GREP_PREVIEW_COUNT,
        handle: {
          id: handle.id,
          tool_name: handle.toolName,
          length: handle.length,
          sha256: handle.sha256,
        },
      },
    };
  }

  const { text, truncated } = truncateOutput(formatted);

  return {
    ok: true,
    name: "grep",
    output: text,
    metadata: {
      matchCount: matches.length,
      truncated
    }
  };
}
