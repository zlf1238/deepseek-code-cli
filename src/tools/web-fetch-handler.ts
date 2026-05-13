import * as child_process from "child_process";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

const MAX_FETCH_CHARS = 10000;
const FETCH_TIMEOUT_MS = 15000;

export async function handleWebFetchTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    return { ok: false, name: "web_fetch", error: "Missing required \"url\" string." };
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, name: "web_fetch", error: "URL must start with http:// or https://." };
  }

  const maxChars = typeof args.maxChars === "number" && args.maxChars > 0
    ? Math.min(args.maxChars, 50000)
    : MAX_FETCH_CHARS;

  try {
    const content = await fetchUrlContent(url);
    const truncated = content.length > maxChars
      ? content.slice(0, maxChars) + `\n… (truncated ${content.length - maxChars} chars)`
      : content;

    context.onProcessStart?.(url, `web_fetch: ${url}`);
    setTimeout(() => context.onProcessExit?.(url), 0);

    return {
      ok: true,
      name: "web_fetch",
      output: truncated,
      metadata: { url, charCount: content.length, truncated: content.length > maxChars },
    };
  } catch (err) {
    return {
      ok: false,
      name: "web_fetch",
      error: `Failed to fetch ${url}: ${String(err)}`,
    };
  }
}

function fetchUrlContent(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn("curl", [
      "-sSL",
      "-m", String(Math.floor(FETCH_TIMEOUT_MS / 1000)),
      "-H", "User-Agent: deepseek-code-cli/1.0",
      url,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        // Strip HTML tags minimally for readability
        const stripped = stdout.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n\s*\n\s*\n/g, "\n\n")
          .replace(/[ \t]+/g, " ")
          .trim();
        resolve(stripped || "(empty response)");
      } else {
        reject(new Error(`curl exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}
