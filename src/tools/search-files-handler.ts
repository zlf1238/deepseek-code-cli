import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_OUTPUT_CHARS = 8000;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];

export async function handleSearchFilesTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) {
    return { ok: false, name: "search_files", error: "Missing required \"pattern\" string." };
  }

  const searchPath = typeof args.path === "string" && args.path.trim()
    ? (path.isAbsolute(args.path) ? args.path : path.join(context.projectRoot, args.path))
    : context.projectRoot;

  if (!fs.existsSync(searchPath)) {
    return { ok: false, name: "search_files", error: `Path not found: ${searchPath}` };
  }

  const caseSensitive = args.caseSensitive === true;
  const includeDirs = args.includeDirs === false ? false : true;

  // On non-Windows platforms (WSL/Linux/macOS), delegate to `find` for
  // superior cross-filesystem performance — the native `find` command runs
  // in kernel space and batches 9P requests better than Node.js readdirSync.
  if (process.platform !== "win32") {
    return await searchWithFind(pattern, searchPath, caseSensitive, includeDirs);
  }

  // Windows fallback: pure Node.js implementation
  return searchWithNode(pattern, searchPath, caseSensitive, includeDirs);
}

/**
 * Linux/macOS/WSL backend: delegate to `find` command.
 * On WSL2 accessing `/mnt/d/` (DrvFs), `find` is 10-100x faster than
 * Node.js `fs.readdirSync` because it avoids per-call 9P protocol overhead.
 */
async function searchWithFind(
  pattern: string,
  searchPath: string,
  caseSensitive: boolean,
  includeDirs: boolean
): Promise<ToolExecutionResult> {
  return new Promise((resolve) => {
    const args: string[] = [searchPath];

    // Build prune expressions for excluded dirs
    const pruneExprs: string[] = [];
    for (const excludeDir of DEFAULT_EXCLUDE_DIRS) {
      pruneExprs.push("-path", `*/${excludeDir}/*`);
    }
    if (pruneExprs.length > 0) {
      args.push("\\(");
      for (let i = 0; i < pruneExprs.length; i += 2) {
        if (i > 0) args.push("-o");
        args.push(pruneExprs[i], pruneExprs[i + 1]);
      }
      args.push("\\)", "-prune", "-o");
    }

    // Match name by substring — escape glob metacharacters for literal matching
    const nameFlag = caseSensitive ? "-name" : "-iname";
    args.push(nameFlag, `*${escapeFindPattern(pattern)}*`);

    // File/directory type filter
    if (includeDirs) {
      args.push("\\(", "-type", "f", "-o", "-type", "d", "\\)");
    } else {
      args.push("-type", "f");
    }

    args.push("-print");

    const child = spawn("find", args, {
      cwd: searchPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (truncated) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = MAX_OUTPUT_CHARS - stdout.length;
      if (remaining <= 0) {
        truncated = true;
        child.kill();
        return;
      }
      stdout += text.slice(0, remaining);
    });

    child.stderr?.on("data", (chunk: string | Buffer) => {
      if (stderr.length >= MAX_CAPTURE_CHARS) return;
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", () => {
      resolve({
        ok: false,
        name: "search_files",
        error: "Failed to spawn find command.",
        metadata: { pattern, path: searchPath },
      });
    });

    child.on("close", (code) => {
      if (code !== null && code !== 0 && code !== 1) {
        resolve({
          ok: false,
          name: "search_files",
          error: stderr || `find failed with exit code ${code}.`,
          metadata: { pattern, path: searchPath, exitCode: code },
        });
        return;
      }

      const files = stdout
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0)
        .sort();

      // Convert absolute paths to relative, append "/" for directories
      const relFiles = files.map((f) => {
        const rel = path.relative(searchPath, f);
        try {
          return fs.statSync(f).isDirectory() ? `${rel}/` : rel;
        } catch {
          return rel;
        }
      });

      let output = relFiles.length > 0
        ? relFiles.join("\n")
        : `No files matching "${pattern}" found.`;

      if (truncated) {
        output += `\n… (truncated, ${relFiles.length} matches found)`;
      }

      resolve({
        ok: true,
        name: "search_files",
        output,
        metadata: { pattern, path: searchPath, matchCount: relFiles.length, truncated },
      });
    });
  });
}

/** Escape find glob metacharacters for literal substring matching. */
function escapeFindPattern(p: string): string {
  return p.replace(/[\[\]?*]/g, "\\$&");
}

/**
 * Pure Node.js fallback for Windows.
 * Synchronous recursive traversal with fs.readdirSync and exclude dirs.
 */
function searchWithNode(
  pattern: string,
  searchPath: string,
  caseSensitive: boolean,
  includeDirs: boolean
): ToolExecutionResult {
  const targetPattern = caseSensitive ? pattern : pattern.toLowerCase();
  const results: string[] = [];
  let truncated = false;
  let outputLength = 0;
  const excludeSet = new Set(DEFAULT_EXCLUDE_DIRS);

  function walk(dir: string): void {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      if (excludeSet.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(searchPath, fullPath);
      const matchTarget = caseSensitive ? entry.name : entry.name.toLowerCase();

      if (matchTarget.includes(targetPattern)) {
        const displayName = entry.isDirectory() ? `${relPath}/` : relPath;
        results.push(displayName);
        outputLength += displayName.length + 1; // +1 for "\n"
        if (outputLength > MAX_OUTPUT_CHARS) {
          truncated = true;
          return;
        }
      }

      if (entry.isDirectory() && includeDirs) {
        walk(fullPath);
      }
    }
  }

  walk(searchPath);

  let output = results.length > 0
    ? results.sort().join("\n")
    : `No files matching "${pattern}" found.`;

  if (truncated) {
    output += `\n… (truncated, ${results.length} matches found)`;
  }

  return {
    ok: true,
    name: "search_files",
    output,
    metadata: { pattern, path: searchPath, matchCount: results.length, truncated },
  };
}
