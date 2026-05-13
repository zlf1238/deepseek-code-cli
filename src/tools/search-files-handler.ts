import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_OUTPUT_CHARS = 8000;

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

  // Convert glob-like pattern to regex-like matching
  const targetPattern = caseSensitive ? pattern : pattern.toLowerCase();

  const results: string[] = [];
  let truncated = false;

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

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(searchPath, fullPath);
      const matchTarget = caseSensitive ? entry.name : entry.name.toLowerCase();

      if (matchTarget.includes(targetPattern)) {
        const displayName = entry.isDirectory() ? `${relPath}/` : relPath;
        results.push(displayName);
        if (results.join("\n").length > MAX_OUTPUT_CHARS) {
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
