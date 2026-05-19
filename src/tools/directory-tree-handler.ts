import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { spillToolOutput } from "./state";

/** 文件/目录条目数超过此阈值时启用 handle 化 */
const TREE_HANDLE_THRESHOLD = 500;
/** handle 化时预览的行数 */
const TREE_PREVIEW_LINES = 150;
const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];

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

  // Non-Windows: delegate to `find` for superior cross-filesystem performance on WSL2
  const useFind = process.platform !== "win32";
  const tree = useFind
    ? buildTreeWithFind(resolved, maxDepth, context.projectRoot)
    : buildTree(resolved, maxDepth, context.projectRoot);
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

interface TreeNode {
  name: string;
  children: TreeNode[];
  isDir: boolean;
}

/**
 * Non-Windows backend: use `find` for fast recursive directory traversal.
 * On WSL2, `find` runs in kernel space and batches 9P requests far more
 * efficiently than per-directory Node.js readdirSync calls.
 * Parses flat find output into a tree structure without extra stat calls.
 */
function buildTreeWithFind(root: string, maxDepth: number, projectRoot: string): string[] {
  const args: string[] = [root];

  // Prune excluded directories
  for (const excludeDir of DEFAULT_EXCLUDE_DIRS) {
    args.push("-path", `*/${excludeDir}/*`, "-prune", "-o");
  }

  // Max depth
  args.push("-maxdepth", String(maxDepth));

  // Include both files and directories
  args.push("\\(", "-type", "f", "-o", "-type", "d", "\\)", "-print");

  const stdout = spawnAndCapture("find", args);
  const rawPaths = stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  // Build tree from flat path list.
  // A path is a directory if another path starts with it + "/".
  // This avoids any fs.statSync calls.
  const pathSet = new Set(rawPaths);

  // First pass: create nodes for all paths
  const nodeMap = new Map<string, TreeNode>();
  nodeMap.set(root, {
    name: root === projectRoot ? "." : path.basename(root),
    children: [],
    isDir: true,
  });
  for (const p of rawPaths) {
    if (p === root) continue;
    const hasChildren = hasAnyChild(p, pathSet);
    nodeMap.set(p, {
      name: path.basename(p),
      children: [],
      isDir: hasChildren,
    });
  }

  // Second pass: link children to parents (parents always appear before children in find output)
  for (const p of rawPaths) {
    if (p === root) continue;
    const parent = path.dirname(p);
    const parentNode = nodeMap.get(parent);
    const node = nodeMap.get(p);
    if (parentNode && node) {
      parentNode.children.push(node);
    }
  }

  // Sort children: dirs first, then alphabetical
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  // Render tree
  return renderTree(nodeMap.get(root)!, maxDepth);
}

/** Check if a path has any child in the set of all paths. */
function hasAnyChild(p: string, pathSet: Set<string>): boolean {
  const prefix = p.endsWith("/") ? p : `${p}/`;
  for (const other of pathSet) {
    if (other.startsWith(prefix) && other !== p) return true;
  }
  return false;
}

function renderTree(rootNode: TreeNode, maxDepth: number): string[] {
  const lines: string[] = [rootNode.name];
  function walk(node: TreeNode, prefix: string, depth: number): void {
    if (depth >= maxDepth) {
      if (node.children.length > 0) {
        lines.push(`${prefix}… (${node.children.length} more, maxDepth reached)`);
      }
      return;
    }

    // Filter dotfiles (except .deepseek-code)
    const filtered = node.children.filter(
      (c) => !(c.name.startsWith(".") && c.name !== ".deepseek-code")
    );

    for (let i = 0; i < filtered.length; i++) {
      const child = filtered[i]!;
      const isLast = i === filtered.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const suffix = child.isDir ? "/" : "";

      lines.push(`${prefix}${connector}${child.name}${suffix}`);

      if (child.isDir) {
        walk(child, `${prefix}${childPrefix}`, depth + 1);
      }
    }
  }
  walk(rootNode, "  ", 0);
  return lines;
}

function spawnAndCapture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_CHARS,
  });
  return result.stdout || "";
}

/**
 * Pure Node.js fallback for Windows.
 * Uses readdirSync with withFileTypes to avoid extra stat calls.
 * Eliminates the O(N log N) stat-in-comparator bug from the old code.
 */
function buildTree(root: string, maxDepth: number, projectRoot: string): string[] {
  const lines: string[] = [];
  const baseName = root === projectRoot ? "." : path.basename(root);
  lines.push(baseName);
  const excludeSet = new Set(DEFAULT_EXCLUDE_DIRS);

  function walk(dir: string, prefix: string, depth: number): void {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: dirs first, then alphabetical — Dirent has isDirectory() without stat
    dirents.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    if (depth >= maxDepth) {
      const remaining = dirents.filter(
        (e) => !(e.name.startsWith(".") && e.name !== ".deepseek-code")
          && !excludeSet.has(e.name)
      );
      if (remaining.length > 0) {
        lines.push(`${prefix}… (${remaining.length} more, maxDepth reached)`);
      }
      return;
    }

    for (let i = 0; i < dirents.length; i++) {
      const entry = dirents[i]!;
      if (entry.name.startsWith(".") && entry.name !== ".deepseek-code") continue;
      if (excludeSet.has(entry.name)) continue;

      const isLast = i === dirents.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(fullPath, `${prefix}${childPrefix}`, depth + 1);
      } else if (entry.isSymbolicLink()) {
        lines.push(`${prefix}${connector}${entry.name} →`);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  walk(root, "  ", 0);
  return lines;
}

function countEntries(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.match(/^(├──|└──)/)) count++;
  }
  return count;
}
