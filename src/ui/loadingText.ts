import type { LlmStreamProgress, SessionEntry } from "../session";

type RunningProcesses = SessionEntry["processes"];

export type LoadingTextInput = {
  progress: LlmStreamProgress | null;
  processes?: RunningProcesses;
  now: number;
};

const STALL_THRESHOLD_MS = 3000;
const PROGRESS_BAR_WIDTH = 10;

export function buildLoadingText(input: LoadingTextInput): string {
  const { progress, processes, now } = input;
  const processText = buildProcessLoadingText(processes, now);
  if (processText) {
    return processText;
  }

  if (!progress) {
    return "Generating...";
  }

  const startedAt = parseTimestamp(progress.startedAt);
  if (startedAt === null) {
    return "Generating...";
  }

  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < STALL_THRESHOLD_MS) {
    return "Generating...";
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const tokens = progress.formattedTokens || "0";

  // 估算进度：假设 30 秒内完成，显示进度条
  const progressPct = Math.min(100, Math.round((elapsedMs / 10000) * 100)); // 10秒估算
  const bar = buildProgressBar(progressPct, PROGRESS_BAR_WIDTH);

  return `Generating... (${elapsedSeconds}s) · ↓ ${tokens} tokens · ${bar}`;
}

/** 构建文本进度条，如 [████░░░░] 40% */
export function buildProgressBar(pct: number, width: number): string {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const filled = Math.min(width, Math.round((clamped / 100) * width));
  const empty = width - filled;
  const filledStr = "\u2588".repeat(filled);  // █
  const emptyStr = "\u2591".repeat(empty);    // ░
  return `[${filledStr}${emptyStr}] ${clamped}%`;
}

function buildProcessLoadingText(processes: RunningProcesses | undefined, now: number): string | null {
  if (!processes || processes.size === 0) {
    return null;
  }

  const first = processes.values().next().value as { startTime: string; command: string } | undefined;
  if (!first) {
    return null;
  }

  return `(${formatElapsedTime(first.startTime, now)}) ${first.command}`;
}

function formatElapsedTime(startTimeIso: string, now: number): string {
  const startTime = parseTimestamp(startTimeIso);
  const elapsedMs = startTime === null ? 0 : Math.max(0, now - startTime);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}
