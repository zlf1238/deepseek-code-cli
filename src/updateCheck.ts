import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";

export type PackageInfo = {
  name: string;
  version: string;
};

type UpdateState = {
  pending?: {
    currentVersion: string;
    latestVersion: string;
    packageName: string;
    checkedAt: string;
  } | null;
  ignoredVersions?: string[];
};

const UPDATE_STATE_FILE = "update-check.json";
const NPM_VIEW_TIMEOUT_MS = 5000;
const MAX_NPM_VIEW_OUTPUT_CHARS = 64 * 1024;

export async function promptForPendingUpdate(packageInfo: PackageInfo): Promise<{ installed: boolean }> {
  const state = readUpdateState();
  const pending = state.pending;
  if (!pending) {
    return { installed: false };
  }

  if (compareVersions(packageInfo.version, pending.latestVersion) >= 0) {
    writeUpdateState({ ...state, pending: null });
    return { installed: false };
  }

  if (state.ignoredVersions?.includes(pending.latestVersion)) {
    writeUpdateState({ ...state, pending: null });
    return { installed: false };
  }

  const installSpec = `${pending.packageName}@${pending.latestVersion}`;
  const installCommand = `npm install -g ${installSpec}`;
  const choice = await promptUpdateChoice({
    currentVersion: packageInfo.version,
    latestVersion: pending.latestVersion,
    installCommand
  });

  if (choice === "install") {
    const ok = await runNpmInstallGlobal(installSpec);
    if (ok) {
      writeUpdateState({ ...state, pending: null });
      process.stdout.write(`\n${chalk.red("DeepSeek Code has been updated. Please restart the CLI to use the new version.")}\n\n`);
    }
    return { installed: ok };
  }

  if (choice === "ignore-version") {
    const ignoredVersions = Array.from(new Set([...(state.ignoredVersions ?? []), pending.latestVersion]));
    writeUpdateState({ ...state, pending: null, ignoredVersions });
    return { installed: false };
  }

  writeUpdateState({ ...state, pending: null });
  return { installed: false };
}

export async function checkForNpmUpdate(packageInfo: PackageInfo): Promise<void> {
  if (!packageInfo.name || !packageInfo.version) {
    return;
  }

  try {
    const latestVersion = await fetchLatestNpmVersion(packageInfo.name);
    if (!latestVersion || compareVersions(latestVersion, packageInfo.version) <= 0) {
      clearPendingUpdate();
      return;
    }

    const state = readUpdateState();
    if (state.ignoredVersions?.includes(latestVersion)) {
      clearPendingUpdate(state);
      return;
    }

    writeUpdateState({
      ...state,
      pending: {
        currentVersion: packageInfo.version,
        latestVersion,
        packageName: packageInfo.name,
        checkedAt: new Date().toISOString()
      }
    });
  } catch {
    // Update checks must never affect CLI startup or normal operation.
  }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

export function getUpdateStatePath(): string {
  return path.join(os.homedir(), ".deepseek-code", UPDATE_STATE_FILE);
}

/** 候选更新类型（保留类型以兼容调用方） */
type UpdatePromptChoice = "install" | "ignore-once" | "ignore-version";

/**
 * 展示更新提示（纯终端输出，不依赖 Ink）。
 * 不再交互——仅打印提示，让用户自行执行安装命令。
 */
async function promptUpdateChoice({
  currentVersion,
  latestVersion,
  installCommand
}: {
  currentVersion: string;
  latestVersion: string;
  installCommand: string;
}): Promise<UpdatePromptChoice> {
  process.stdout.write(
    `\n${chalk.yellow("╭────────────────────────────────────────────╮")}\n` +
    `${chalk.yellow("│")}${chalk.bold("  DeepSeek Code CLI 更新可用")}${chalk.yellow("                  │")}\n` +
    `${chalk.yellow("│")}  当前版本: ${currentVersion.padEnd(34)}${chalk.yellow("│")}\n` +
    `${chalk.yellow("│")}  最新版本: ${chalk.green(latestVersion.padEnd(34))}${chalk.yellow("│")}\n` +
    `${chalk.yellow("╰────────────────────────────────────────────╯")}\n` +
    `\n  安装命令: ${chalk.cyan(installCommand)}\n` +
    `  手动执行上述命令更新后重启 CLI 即可。\n\n`
  );
  return "ignore-once";
}

async function runNpmInstallGlobal(installSpec: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", installSpec], {
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("error", (error) => {
      process.stderr.write(`Failed to start npm install: ${error.message}\n`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      process.stderr.write(`npm install exited with code ${code ?? "unknown"}.\n`);
      resolve(false);
    });
  });
}

async function fetchLatestNpmVersion(packageName: string): Promise<string | null> {
  const result = await runNpmViewLatestVersion(packageName, NPM_VIEW_TIMEOUT_MS);
  if (!result.ok) {
    return null;
  }
  return parseNpmViewVersion(result.stdout);
}

function runNpmViewLatestVersion(
  packageName: string,
  timeoutMs: number
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["view", packageName, "dist-tags.latest", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stdout = "";
    let settled = false;
    const finish = (result: { ok: true; stdout: string } | { ok: false }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: string | Buffer) => {
      if (stdout.length >= MAX_NPM_VIEW_OUTPUT_CHARS) {
        return;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdout += text.slice(0, MAX_NPM_VIEW_OUTPUT_CHARS - stdout.length);
    });

    child.on("error", () => finish({ ok: false }));
    child.on("close", (code) => {
      finish(code === 0 ? { ok: true, stdout } : { ok: false });
    });
  });
}

export function parseNpmViewVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    return trimmed.split(/\r?\n/)[0]?.trim() || null;
  }
}

function readUpdateState(): UpdateState {
  const statePath = getUpdateStatePath();
  if (!fs.existsSync(statePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as UpdateState;
    return {
      pending: parsed.pending ?? null,
      ignoredVersions: Array.isArray(parsed.ignoredVersions)
        ? parsed.ignoredVersions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : []
    };
  } catch {
    return {};
  }
}

function writeUpdateState(state: UpdateState): void {
  const statePath = getUpdateStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearPendingUpdate(state = readUpdateState()): void {
  if (!state.pending) {
    return;
  }
  writeUpdateState({ ...state, pending: null });
}

function parseVersion(value: string): number[] {
  return value
    .split("-", 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
