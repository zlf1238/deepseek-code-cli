import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult, ToolExecutionFollowUpMessage } from "./executor";

const MAX_OUTPUT_CHARS = 20000;
const MAX_CAPTURE_CHARS = 5 * 1024 * 1024;

type JobEntry = {
  id: string;
  command: string;
  startTime: string;
  pid: number | undefined;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
};

/** Map from sessionId to map from jobId to JobEntry. */
const sessionJobs = new Map<string, Map<string, JobEntry>>();

function getJobs(sessionId: string): Map<string, JobEntry> {
  let jobs = sessionJobs.get(sessionId);
  if (!jobs) {
    jobs = new Map();
    sessionJobs.set(sessionId, jobs);
  }
  return jobs;
}

export async function handleRunBackgroundTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { ok: false, name: "run_background", error: "Missing required \"command\" string." };
  }

  // 自动验证命令中引用的文件路径是否存在
  const pathError = verifyCommandPaths(command, context.projectRoot);
  if (pathError) {
    return {
      ok: false,
      name: "run_background",
      error: pathError
    };
  }

  const description = typeof args.description === "string" ? args.description.trim() : command;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const child = spawn(command, {
    shell: true,
    cwd: context.projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let outputTruncated = false;

  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length < MAX_CAPTURE_CHARS) {
      output += chunk.toString();
      if (output.length > MAX_CAPTURE_CHARS) {
        output = output.slice(0, MAX_CAPTURE_CHARS);
        outputTruncated = true;
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (output.length < MAX_CAPTURE_CHARS) {
      output += chunk.toString();
      if (output.length > MAX_CAPTURE_CHARS) {
        output = output.slice(0, MAX_CAPTURE_CHARS);
        outputTruncated = true;
      }
    }
  });

  const job: JobEntry = {
    id: jobId,
    command,
    startTime: new Date().toISOString(),
    pid: child.pid,
    status: "running",
    exitCode: null,
    output: "",
    outputTruncated: false,
  };

  getJobs(context.sessionId).set(jobId, job);

  child.on("exit", (code, signal) => {
    const j = getJobs(context.sessionId).get(jobId);
    if (j) {
      j.status = code === 0 ? "completed" : "failed";
      j.exitCode = code;
      j.output = output;
      j.outputTruncated = outputTruncated;
    }
  });

  child.on("error", (err) => {
    const j = getJobs(context.sessionId).get(jobId);
    if (j) {
      j.status = "failed";
      j.output = `spawn error: ${err.message}`;
    }
  });

  const truncatedOutput = output.length > MAX_OUTPUT_CHARS
    ? output.slice(0, MAX_OUTPUT_CHARS) + `\n… (output cap reached, use job_output to re-fetch)`
    : output || "(no output yet)";

  return {
    ok: true,
    name: "run_background",
    output: `Job started: ${jobId}\n  command: ${command}\n  pid: ${child.pid ?? "N/A"}\n\n${truncatedOutput}`,
    metadata: { jobId, pid: child.pid, command: description },
  };
}

export async function handleJobOutputTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  if (!jobId) {
    return { ok: false, name: "job_output", error: "Missing required \"jobId\" string." };
  }

  const job = getJobs(context.sessionId).get(jobId);
  if (!job) {
    // List available jobs
    const available = Array.from(getJobs(context.sessionId).keys()).join(", ") || "(none)";
    return { ok: false, name: "job_output", error: `Unknown jobId: ${jobId}. Available: ${available}` };
  }

  const output = job.output || "(no output yet)";
  const truncated = output.length > MAX_OUTPUT_CHARS
    ? output.slice(0, MAX_OUTPUT_CHARS) + `\n… (total ${output.length} chars)`
    : output;

  return {
    ok: true,
    name: "job_output",
    output: [
      `Job: ${job.id}`,
      `  command: ${job.command}`,
      `  status: ${job.status}`,
      `  exitCode: ${job.exitCode ?? "N/A"}`,
      `  pid: ${job.pid ?? "N/A"}`,
      ``,
      truncated,
    ].join("\n"),
    metadata: { jobId, status: job.status, exitCode: job.exitCode },
  };
}

export async function handleListJobsTool(
  _args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const jobs = Array.from(getJobs(context.sessionId).values());
  if (jobs.length === 0) {
    return { ok: true, name: "list_jobs", output: "No background jobs." };
  }

  const lines = jobs.map((j) => {
    const icon = j.status === "running" ? "▸" : j.status === "completed" ? "✓" : "✗";
    return `  ${icon} ${j.id} — ${j.command} (${j.status}, exit=${j.exitCode ?? "N/A"})`;
  });

  return {
    ok: true,
    name: "list_jobs",
    output: `${jobs.length} job(s):\n${lines.join("\n")}`,
    metadata: { count: jobs.length },
  };
}

/**
 * 验证命令中引用的文件路径是否存在。
 * 仅检查以常见脚本/源码扩展名结尾且包含路径分隔符的 token。
 */
function verifyCommandPaths(command: string, projectRoot: string): string | null {
  const fileExtensions = /\.(ts|js|tsx|jsx|mjs|cjs|py|sh|go|rs|java|c|cpp|rb|php)$/i;
  const tokens = command.split(/\s+/);

  for (const token of tokens) {
    // 跳过命令行选项（以 - 开头）
    if (token.startsWith("-")) continue;
    // 跳过纯命令（不包含路径分隔符）
    if (!token.includes("/") && !token.includes("\\")) continue;
    // 跳过包含 glob 通配符的 token（shell 会自行展开）
    if (/[*?[{}]/.test(token)) continue;

    // 仅检查常见源码扩展名
    if (fileExtensions.test(token)) {
      const resolvedPath = path.isAbsolute(token)
        ? token
        : path.join(projectRoot, token);

      if (!fs.existsSync(resolvedPath)) {
        return `File not found: ${resolvedPath}\n  Path was extracted from command: ${command}`;
      }
    }
  }

  return null;
}

export async function handleStopJobTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  if (!jobId) {
    return { ok: false, name: "stop_job", error: "Missing required \"jobId\" string." };
  }

  const job = getJobs(context.sessionId).get(jobId);
  if (!job) {
    return { ok: false, name: "stop_job", error: `Unknown jobId: ${jobId}` };
  }

  if (job.status !== "running") {
    return { ok: true, name: "stop_job", output: `Job ${jobId} is not running (status: ${job.status}).` };
  }

  if (job.pid) {
    try {
      process.kill(-job.pid, "SIGTERM");
    } catch {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        return { ok: false, name: "stop_job", error: `Failed to send SIGTERM to PID ${job.pid}.` };
      }
    }
  }

  job.status = "failed";
  job.exitCode = -1;

  return {
    ok: true,
    name: "stop_job",
    output: `Stopped job ${jobId} (${job.command}).`,
    metadata: { jobId },
  };
}
