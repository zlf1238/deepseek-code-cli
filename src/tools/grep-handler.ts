import { spawn } from "child_process";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_OUTPUT_CHARS = 30000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];

type GrepMatch = {
  file: string;
  line: number;
  content: string;
  before: string[];
  after: string[];
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
  const args: string[] = ["-rn", "--color=never"];

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
    const matchHyphen = rawLine.match(/^([^-]+)-(\d+)-(.*)$/);

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
    } else if (matchHyphen && currentMatch) {
      // This is a context line
      const lineContent = matchHyphen[3];
      if (afterCount < context) {
        // Could be before or after - we determine by line number
        const lineNum = parseInt(matchHyphen[2], 10);
        if (lineNum < currentMatch.line) {
          currentMatch.before.push(lineContent);
        } else {
          currentMatch.after.push(lineContent);
          afterCount++;
        }
      }
    } else if (matchHyphen) {
      // Context line without current match (before the first match in file)
      // Ignore orphaned context
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

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve) => {
    const child = spawn("grep", grepArgs, {
      cwd: context.projectRoot,
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

  // grep returns exit code 1 when no matches found - that's not an error
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
    return {
      ok: false,
      name: "grep",
      error: stderr || `grep failed with exit code ${exitCode}.`,
      metadata: { exitCode }
    };
  }

  const matches = parseGrepOutput(stdout, contextLines);
  const formatted = formatGrepResult(matches);
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
