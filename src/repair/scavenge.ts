/**
 * 借鉴 Reasonix repair/scavenge.ts: 从 reasoning_content 中捞取 DeepSeek
 * 忘记放入 tool_calls 字段的 tool call。支持 3 种 JSON 模式。
 */

import type { ToolCall } from "../tools/executor";

const MAX_SCAVENGE_INPUT = 100 * 1024;

export interface ScavengeResult {
  calls: ToolCall[];
  notes: string[];
}

export function scavengeToolCalls(
  reasoningContent: string | null | undefined,
  allowedNames: Set<string>,
): ScavengeResult {
  if (!reasoningContent) return { calls: [], notes: [] };
  if (reasoningContent.length > MAX_SCAVENGE_INPUT) {
    return { calls: [], notes: [`scavenge skipped: content too large (${reasoningContent.length} chars)`] };
  }

  const calls: ToolCall[] = [];
  const notes: string[] = [];
  const maxCalls = 4;

  for (const candidate of iterateJsonObjects(reasoningContent)) {
    if (calls.length >= maxCalls) break;
    const call = coerceToToolCall(candidate, allowedNames);
    if (call) {
      call.id = `scavenged_${crypto.randomUUID().slice(0, 8)}`;
      calls.push(call);
      notes.push(`scavenged call: ${call.function.name}`);
    }
  }

  return { calls, notes };
}

/** Yield every top-level JSON object substring in `text`. */
function* iterateJsonObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escaped) { escaped = false; continue; }
      if (inString) {
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { yield text.slice(i, j + 1); i = j; break; }
      }
    }
  }
}

function coerceToToolCall(
  candidateJson: string,
  allowedNames: ReadonlySet<string>,
): Omit<ToolCall, "id"> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(candidateJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Pattern 1: { name, arguments }
  if (typeof obj.name === "string" && allowedNames.has(obj.name)) {
    return {
      type: "function" as const,
      function: {
        name: obj.name,
        arguments: typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? {}),
      },
    };
  }

  // Pattern 2: OpenAI-style { type: "function", function: { name, arguments } }
  if (obj.type === "function" && obj.function && typeof obj.function === "object") {
    const fn = obj.function as Record<string, unknown>;
    if (typeof fn.name === "string" && allowedNames.has(fn.name)) {
      return {
        type: "function" as const,
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      };
    }
  }

  // Pattern 3: { tool_name, tool_args }
  if (typeof obj.tool_name === "string" && allowedNames.has(obj.tool_name)) {
    return {
      type: "function" as const,
      function: {
        name: obj.tool_name,
        arguments: JSON.stringify(obj.tool_args ?? {}),
      },
    };
  }

  return null;
}
