import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { spillToolOutput } from "./state";

/** 文件/目录条目数超过此阈值时启用 handle 化 */
const TREE_HANDLE_THRESHOLD = 500;
/** handle 化时预览的行数 */
const TREE_PREVIEW_LINES = 150;

export async function handleDirectoryTreeTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const dirPath = typeof args.path === "string" ? args.path.trim() : context.projectRoot;
  const maxDepth = typeof args.maxDepth === "number" && args.maxDepth > 0 ? args.maxDepth : 3;
  const resolved = path.isAbsolute(dirPath) ? dirPath : path.join(context.projectRoot, dirPath);

  if (!fs.existsSync(resolved)) {
    return { ok: false, name: "directory_tree", error: `Directory not found: ${resolved}` };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, name: "directory_tree", error: `Not a directory: ${resolved}` };
  }

  const tree = buildTree(resolved, maxDepth, context.projectRoot);
  const entries = countEntries(tree);
  const output = tree.join("\n");

  // 大项目（超过阈值条目数）→ handle 化：溢出全量，返回预览
  if (entries > TREE_HANDLE_THRESHOLD) {
    const previewLines = tree.slice(0, TREE_PREVIEW_LINES);
    const previewOutput = previewLines.join("\n");

    const handle = spillToolOutput(
      context.sessionId,
      context.toolCall.id,
      "directory_tree",
      output
    );

    const resultOutput = previewOutput
      + `\n\n... (${entries - countEntries(previewLines)} more entries not shown, ${entries} total, ${output.length} chars)`
      + `\nUse retrieve_tool_result(ref="${handle.id}", mode="lines", lines="X-Y")`
      + ` or retrieve_tool_result(ref="${handle.id}", mode="head") / mode="tail"`
      + ` to explore the full tree.`
      + `\nHandle sha256: ${handle.sha256.slice(0, 16)}...`;

    return {
      ok: true,
      name: "directory_tree",
      output: resultOutput,
      metadata: {
        root: resolved,
        maxDepth,
        entries,
        previewEntries: countEntries(previewLines),
        chars: output.length,
        handle: {
          id: handle.id,
          tool_name: handle.toolName,
          length: handle.length,
          sha256: handle.sha256,
        },
      },
    };
  }

  return {
    ok: true,
    name: "directory_tree",
    output,
    metadata: { root: resolved, maxDepth, entries, chars: output.length },
  };
}

function buildTree(root: string, maxDepth: number, projectRoot: string): string[] {
  const lines: string[] = [];
  const baseName = root === projectRoot ? "." : path.basename(root);
  lines.push(baseName);

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth >= maxDepth) {
      const entries = readEntries(dir);
      if (entries.length > 0) {
        lines.push(`${prefix}… (${entries.length} more, maxDepth reached)`);
      }
      return;
    }

    const entries = readEntries(dir);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const fullPath = path.join(dir, entry);

      if (entry.startsWith(".") && entry !== ".deepseek-code") continue;

      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        lines.push(`${prefix}${connector}${entry}/`);
        walk(fullPath, `${prefix}${childPrefix}`, depth + 1);
      } else if (stat.isSymbolicLink()) {
        lines.push(`${prefix}${connector}${entry} →`);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    }
  }

  walk(root, "  ", 0);
  return lines;
}

function readEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => {
      const aDir = isDir(path.join(dir, a));
      const bDir = isDir(path.join(dir, b));
      if (aDir && !bDir) return -1;
      if (!aDir && bDir) return 1;
      return a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function countEntries(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.match(/^(├──|└──)/)) count++;
  }
  return count;
}
