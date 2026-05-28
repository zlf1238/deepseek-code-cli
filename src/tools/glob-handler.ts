import { spawn } from "child_process";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_OUTPUT_CHARS = 30000;

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

  // 辅助函数：spawn 进程并捕获输出
  const doSpawn = (cmd: string, args: string[]) => new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve) => {
    const child = spawn(cmd, args, {
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

  let { stdout, stderr, exitCode } = await doSpawn("rg", ["--files", "-g", pattern, dir]);
  if (exitCode === null) {
    return {
      ok: false,
      name: "glob",
      error: "ripgrep (rg) 未安装。请安装：winget install BurntSushi.ripgrep (Windows) 或 brew install ripgrep (macOS) 或 apt install ripgrep (Linux)。"
    };
  }

  if (exitCode !== null && exitCode !== 0) {
    return {
      ok: false,
      name: "glob",
      error: stderr || `search failed with exit code ${exitCode}.`,
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
