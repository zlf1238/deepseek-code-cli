import { spawn } from "child_process";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { loadRTKConfig, wrapGrepArgs } from "./rtk";
import { spillToolOutput, type ToolOutputHandle } from "./state";

const MAX_OUTPUT_CHARS = 30000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];

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
  ignoreCase: boolean
): string[] {
  const args: string[] = ["-rnH", "--color=never"];

  if (ignoreCase) {
    args.push("-i");
  }

  args.push("-C", String(context));

  if (include && include.trim()) {
    for (const inc of include.split(",").map((s) => s.trim()).filter(Boolean)) {
      args.push("--include", inc);
    }
  }

  for (const excludeDir of DEFAULT_EXCLUDE_DIRS) {
    args.push("--exclude-dir", excludeDir);
  }

  args.push(pattern, dir);
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

/** Run grep (or rtk-wrapped grep) and return stdout/stderr/exitCode. */
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

  const dir = resolveSearchDir(context.projectRoot, searchPath);

  let includePattern: string | undefined;
  if (typeof args.include === "string" && args.include.trim()) {
    includePattern = args.include.trim();
  }

  const grepArgs = buildGrepArgs(pattern, dir, includePattern, contextLines, ignoreCase);

  const rtkConfig = loadRTKConfig();
  const { command: spawnCmd, args: spawnArgs } = wrapGrepArgs(grepArgs, rtkConfig);

  const result = await runGrep(spawnCmd, spawnArgs, context.projectRoot);
  let stdout = result.stdout;
  let stderr = result.stderr;
  let exitCode = result.exitCode;

  // grep returns exit code 1 when no matches found - that's not an error
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    return {
      ok: false,
      name: "grep",
      error: stderr || `grep failed with exit code ${exitCode}.`,
      metadata: { exitCode }
    };
  }

  let matches = parseGrepOutput(stdout, contextLines);

  // rtk may silently return empty results. Fall back to bare grep.
  const usedRTK = rtkConfig.enabled && spawnCmd !== "grep";
  if (matches.length === 0 && usedRTK && exitCode !== null && exitCode <= 1) {
    const fallback = await runGrep("grep", grepArgs, context.projectRoot);
    if (fallback.exitCode !== null && fallback.exitCode <= 1) {
      stdout = fallback.stdout;
      stderr = fallback.stderr;
      exitCode = fallback.exitCode;
      matches = parseGrepOutput(fallback.stdout, contextLines);
    }
    if (matches.length === 0 && fallback.stderr) {
      return {
        ok: false,
        name: "grep",
        error: "grep failed (rtk returned empty, bare grep also failed): " + fallback.stderr,
        metadata: { exitCode: fallback.exitCode }
      };
    }
  }

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
