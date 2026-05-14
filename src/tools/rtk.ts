/**
 * RTK (Reduce Token Kit) integration module.
 *
 * Provides output compression for commands that produce large amounts of text
 * (bash, grep, glob/find). When enabled, commands are piped through `rtk`
 * which groups, deduplicates, and truncates output to reduce token consumption.
 *
 * Configuration priority:
 *   1. settings.json → rtk.enabled
 *   2. Environment variable RTK_ENABLED=1
 *   3. Default: disabled
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface RTKConfig {
  enabled: boolean;
  binaryPath: string;
  exclude: string[];
}

/** Default command prefixes that should skip RTK wrapping. */
const DEFAULT_EXCLUDE_PREFIXES = [
  "tsc",
  "npm run",
  "npx tsc",
  "node ",
  "esbuild",
  "webpack",
  "vite",
  "jest",
  "vitest",
  "pytest",
  "cargo",
];

/** Cache the availability check result for the lifetime of the process. */
let availabilityCache: boolean | null = null;

/**
 * Read RTK config from settings.json and environment variables.
 * Settings file takes precedence over env vars.
 */
export function loadRTKConfig(): RTKConfig {
  let enabled = process.env.RTK_ENABLED === "1";
  let binaryPath = process.env.RTK_BINARY || "rtk";
  let exclude: string[] = [];

  // Try reading from settings.json
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(raw);
      if (settings?.rtk?.enabled === true) {
        enabled = true;
      } else if (settings?.rtk?.enabled === false) {
        enabled = false;
      }
      if (typeof settings?.rtk?.binaryPath === "string" && settings.rtk.binaryPath.trim()) {
        binaryPath = settings.rtk.binaryPath.trim();
      }
      if (Array.isArray(settings?.rtk?.exclude) && settings.rtk.exclude.every((s: unknown) => typeof s === "string")) {
        exclude = settings.rtk.exclude;
      }
    }
  } catch {
    // Ignore read errors — fall back to env vars
  }

  return { enabled, binaryPath, exclude };
}

/**
 * Check if the `rtk` binary is actually available on the system PATH.
 * Result is cached after the first check.
 */
export function isRTKAvailable(config: RTKConfig): boolean {
  if (!config.enabled) {
    return false;
  }

  if (availabilityCache !== null) {
    return availabilityCache;
  }

  try {
    if (process.platform === "win32") {
      // On Windows, use `where` instead of `which`
      execSync(`where ${config.binaryPath}`, { stdio: "pipe", timeout: 3000 });
    } else {
      execSync(`which ${config.binaryPath}`, { stdio: "pipe", timeout: 3000 });
    }
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }

  return availabilityCache;
}

/**
 * Wrap a shell command string with `rtk` prefix if available.
 * Example: "git status" → "rtk git status"
 * Commands whose trimmed prefix matches an entry in the exclude list are not wrapped.
 */
export function wrapWithRTK(command: string, config: RTKConfig): string {
  if (!isRTKAvailable(config)) {
    return command;
  }
  if (shouldExcludeFromRTK(command, config.exclude)) {
    return command;
  }
  return `${config.binaryPath} ${command}`;
}

/**
 * Check if a command should skip RTK wrapping.
 * Matches against DEFAULT_EXCLUDE_PREFIXES + user-configured exclude list.
 */
function shouldExcludeFromRTK(command: string, userExclude: string[]): boolean {
  const trimmed = command.trimStart();
  const allExcludes = [...DEFAULT_EXCLUDE_PREFIXES, ...userExclude];
  return allExcludes.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Get the command name to use for spawn: either "rtk" or the original.
 * For grep/find handlers that spawn commands directly.
 */
export function getRTKCommand(originalCommand: string, config: RTKConfig): string {
  if (!isRTKAvailable(config)) {
    return originalCommand;
  }
  return config.binaryPath;
}

/**
 * Build rtk-wrapped spawn arguments for grep.
 * When RTK is active, we spawn: `rtk grep <original-args>`
 */
export function wrapGrepArgs(originalArgs: string[], config: RTKConfig): { command: string; args: string[] } {
  if (!isRTKAvailable(config)) {
    return { command: "grep", args: originalArgs };
  }
  return { command: config.binaryPath, args: ["grep", ...originalArgs] };
}

/**
 * Build rtk-wrapped spawn arguments for find.
 * When RTK is active, we spawn: `rtk find <original-args>`
 */
export function wrapFindArgs(originalArgs: string[], config: RTKConfig): { command: string; args: string[] } {
  if (!isRTKAvailable(config)) {
    return { command: "find", args: originalArgs };
  }
  return { command: config.binaryPath, args: ["find", ...originalArgs] };
}
