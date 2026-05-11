import { spawn } from "child_process";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { loadRTKConfig, wrapFindArgs } from "./rtk";

const MAX_OUTPUT_CHARS = 30000;
const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".nuxt"];

function resolveSearchDir(root: string, targetPath: string | undefined): string {
  if (!targetPath || !targetPath.trim()) {
    return root;
  }
  const resolved = path.resolve(root, targetPath.trim());
  if (!resolved.startsWith(root)) {
    return root;
  }
  return resolved;
}

function buildFindArgs(pattern: string, dir: string): string[] {
  const args: string[] = [dir];

  const parts = pattern.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1];

  // Build path prune expressions for excluded dirs
  const pruneExprs: string[] = [];
  for (const excludeDir of DEFAULT_EXCLUDE_DIRS) {
    pruneExprs.push("-path", `*/${excludeDir}/*`);
  }

  if (pruneExprs.length > 0) {
    args.push("\\(");
    for (let i = 0; i < pruneExprs.length; i += 2) {
      if (i > 0) {
        args.push("-o");
      }
      args.push(pruneExprs[i], pruneExprs[i + 1]);
    }
    args.push("\\)", "-prune", "-o");
  }

  // Depth: if pattern has no slash (just "*.ts"), limit to current dir by default
  // But the user can pass "**/*.ts" for recursive
  if (parts.length === 1 && !pattern.startsWith("**")) {
    args.push("-maxdepth", "1");
  }

  // Match by name
  args.push("-name", fileName);

  // Only files
  args.push("-type", "f");

  // Print the path
  args.push("-print");

  return args;
}

function formatFileList(files: string[]): string {
  if (files.length === 0) {
    return "(no files found)";
  }
  return files.join("\n");
}

export async function handleGlobTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (!pattern) {
    return {
      ok: false,
      name: "glob",
      error: "Missing required \"pattern\" string."
    };
  }

  const searchPath = typeof args.path === "string" ? args.path : undefined;
  const dir = resolveSearchDir(context.projectRoot, searchPath);
  const findArgs = buildFindArgs(pattern, dir);

  const rtkConfig = loadRTKConfig();
  const { command: spawnCmd, args: spawnArgs } = wrapFindArgs(findArgs, rtkConfig);

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: context.projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let errorOut = "";

    child.stdout?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length < MAX_OUTPUT_CHARS) {
        output += text;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (errorOut.length < MAX_OUTPUT_CHARS) {
        errorOut += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
    });

    child.on("close", (code) => {
      resolve({
        stdout: output,
        stderr: errorOut,
        exitCode: typeof code === "number" ? code : null
      });
    });

    child.on("error", () => {
      resolve({ stdout: output, stderr: errorOut, exitCode: null });
    });
  });

  if (exitCode !== null && exitCode !== 0) {
    return {
      ok: false,
      name: "glob",
      error: stderr || `find failed with exit code ${exitCode}.`,
      metadata: { exitCode }
    };
  }

  const files = stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .sort();

  const output = formatFileList(files);

  return {
    ok: true,
    name: "glob",
    output,
    metadata: {
      fileCount: files.length
    }
  };
}
