import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

export async function handleGetFileInfoTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
  if (!filePath) {
    return { ok: false, name: "get_file_info", error: "Missing required \"file_path\" string." };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.join(context.projectRoot, filePath);

  try {
    const stat = fs.statSync(resolved);
    const info: Record<string, unknown> = {
      path: resolved,
      size: stat.size,
      sizeFormatted: formatSize(stat.size),
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
      readable: true,
      writable: true,
    };

    // Count lines for text files (only if < 1MB)
    if (stat.isFile() && stat.size < 1024 * 1024) {
      try {
        const content = fs.readFileSync(resolved, "utf8");
        info.lines = content.split("\n").length;
        // Check if binary by looking for null bytes in first 8KB
        const head = content.slice(0, 8192);
        info.isTextFile = !head.includes("\x00");
      } catch {
        info.isTextFile = false;
      }
    }

    // For symlinks, show the target
    if (stat.isSymbolicLink()) {
      try {
        info.symlinkTarget = fs.readlinkSync(resolved);
      } catch { /* ignore */ }
    }

    // Build human-readable output
    const icon = stat.isDirectory() ? "📁" : stat.isSymbolicLink() ? "🔗" : "📄";
    const lines = [`${icon} ${path.relative(context.projectRoot, resolved) || path.basename(resolved)}`];
    lines.push(`  Size: ${info.sizeFormatted} (${info.size} bytes)`);
    if (info.lines !== undefined) lines.push(`  Lines: ${info.lines}`);
    lines.push(`  Modified: ${info.modified}`);
    if (info.symlinkTarget) lines.push(`  → ${info.symlinkTarget}`);

    return {
      ok: true,
      name: "get_file_info",
      output: lines.join("\n"),
      metadata: info,
    };
  } catch (err) {
    return {
      ok: false,
      name: "get_file_info",
      error: `Cannot access ${resolved}: ${String(err)}`,
    };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
