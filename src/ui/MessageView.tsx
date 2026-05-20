import React from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "./markdown";
import type { SessionMessage } from "../session";

type Props = {
  message: SessionMessage;
  verboseMode?: boolean;
  /** Whether this thinking message is expanded (showing full content) */
  isExpanded?: boolean;
  /** Callback when user wants to toggle expand/collapse */
  onToggle?: () => void;
  /** Index of this thinking message (1-based, for display) */
  thinkingIndex?: number;
  /** Total count of thinking messages */
  totalThinkingCount?: number;
};

/**
 * Estimate token count from reasoning text length.
 * Rough: ~4 chars per token for Chinese text, ~5 for English.
 */
function estimateTokens(text: string): number {
  const charCount = text.length;
  return Math.round(charCount / 4.5);
}

export function MessageView({
  message,
  verboseMode,
  isExpanded,
  onToggle,
  thinkingIndex,
  totalThinkingCount,
}: Props): React.ReactElement | null {
  if (!message.visible) {
    return null;
  }

  if (message.role === "user") {
    const text = message.content || "(no content)";
    return (
      <Box flexDirection="column" marginY={0}>
        <Text color="green">{`❯ ${text}`}</Text>
        {Array.isArray(message.contentParams) && message.contentParams.length > 0 ? (
          <Text color="green">{`  📎 ${message.contentParams.length} image attachment(s)`}</Text>
        ) : null}
      </Box>
    );
  }

  if (message.role === "assistant") {
    const isThinking = Boolean(message.meta?.asThinking);
    const content = (message.content || "").trim();
    const reasoningContent = getReasoningContent(message);

    // ── asThinking 消息（纯思考过程） ──
    if (isThinking) {
      // 非 verbose 模式：完全隐藏
      if (!verboseMode) {
        return null;
      }
      if (!reasoningContent) {
        return null;
      }

      // 已折叠：显示摘要行
      if (!isExpanded) {
        const tokens = estimateTokens(reasoningContent);
        const indexLabel = totalThinkingCount && totalThinkingCount > 1
          ? ` (${thinkingIndex}/${totalThinkingCount})`
          : "";
        return (
          <Box flexDirection="column" marginY={0}>
            <Text dimColor>
              {`  ▸ 思考过程${indexLabel} (${tokens} tokens) [按⏎展开]`}
            </Text>
          </Box>
        );
      }

      // 已展开：显示完整内容
      return (
        <Box flexDirection="column" marginY={0}>
          <Box flexDirection="row">
            <Text dimColor>{`  ▸ 思考过程`}</Text>
            <Text dimColor>{` [按⏎折叠]`}</Text>
          </Box>
          <Box marginLeft={4} flexDirection="column">
            <Text dimColor>{renderMarkdown(reasoningContent)}</Text>
          </Box>
        </Box>
      );
    }

    // ── 普通 assistant 消息（含 reasoning 时在 verbose 模式下展示思考过程） ──
    return (
      <Box flexDirection="column" marginY={0}>
        <Text color="cyan" bold>Assistant</Text>
        {verboseMode && reasoningContent ? (
          <Box marginLeft={2} flexDirection="column">
            {isExpanded ? (
              <>
                <Text dimColor>{`  ▸ 思考过程 [按⏎折叠]`}</Text>
                <Box marginLeft={2} flexDirection="column">
                  <Text dimColor>{renderMarkdown(reasoningContent)}</Text>
                </Box>
              </>
            ) : (
              <Text dimColor>{`  ▸ 思考过程 (${estimateTokens(reasoningContent)} tokens) [按⏎展开]`}</Text>
            )}
          </Box>
        ) : null}
        <Box marginLeft={2} flexDirection="column">
          {content ? <Text>{renderMarkdown(content)}</Text> : null}
        </Box>
      </Box>
    );
  }

  if (message.role === "tool") {
    // 步骤指示器（隐藏执行结果时显示的精简步骤描述）
    if (message.meta?.isStepIndicator) {
      const stepDesc = typeof message.meta.stepDescription === "string"
        ? message.meta.stepDescription
        : "正在执行...";
      return (
        <Box marginY={0}>
          <Text dimColor>{`  ● ${stepDesc}`}</Text>
        </Box>
      );
    }

    const summary = buildToolSummary(message);
    const diffLines = getToolDiffPreviewLines(summary);
    return (
      <Box flexDirection="column" marginY={0}>
        <StatusLine
          bulletColor={summary.ok ? "green" : "red"}
          name={formatStatusName(summary.name)}
          params={formatToolStatusParams(summary)}
        />
        {diffLines.length > 0 ? <DiffPreview lines={diffLines} /> : null}
      </Box>
    );
  }

  if (message.role === "system") {
    if (message.meta?.skill) {
      return (
        <Box marginY={0}>
          <Text color="magenta">⚡ Loaded skill: {message.meta.skill.name}</Text>
        </Box>
      );
    }
    if (message.meta?.isSummary) {
      const statusColor = (message.messageParams as { statusColor?: string } | null)?.statusColor ?? "gray";
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={statusColor as Parameters<typeof Text>[0]["color"]} bold>{message.content}</Text>
        </Box>
      );
    }
    return null;
  }

  return null;
}

function StatusLine({
  bulletColor,
  name,
  params
}: {
  bulletColor: "gray" | "green" | "red";
  name: string;
  params: string;
}): React.ReactElement {
  return (
    <Text wrap="truncate-end">
      {[
        <Text key="bullet" color={bulletColor}>•</Text>,
        " ",
        <Text key="name" bold>{name}</Text>,
        params ? <Text key="params" color="white">{`  ${params}`}</Text> : null
      ]}
    </Text>
  );
}

function formatToolStatusParams(summary: ToolSummary): string {
  const params = firstNonEmptyLine(summary.params);
  return summary.name.toLowerCase() === "bash" ? params : truncate(params, 120);
}

type ToolSummary = {
  name: string;
  params: string;
  ok: boolean;
  metadata: Record<string, unknown> | null;
};

type DiffPreviewLine = {
  marker: string;
  content: string;
  kind: "added" | "removed" | "context";
};

function buildToolSummary(message: SessionMessage): ToolSummary {
  const payload = parseToolPayload(message.content);
  const metaFunctionName =
    message.meta?.function && typeof (message.meta.function as { name?: unknown }).name === "string"
      ? (message.meta.function as { name: string }).name
      : null;
  const name = payload.name || metaFunctionName || "tool";
  const params = name === "AskUserQuestion"
    ? extractAskUserQuestionParams(message) || getMetaParams(message)
    : getMetaParams(message);

  return {
    name,
    params,
    ok: payload.ok !== false,
    metadata: payload.metadata
  };
}

function getMetaParams(message: SessionMessage): string {
  return typeof message.meta?.paramsMd === "string" ? message.meta.paramsMd.trim() : "";
}

function extractAskUserQuestionParams(message: SessionMessage): string {
  const fromFunction = extractQuestionsFromToolFunction(message.meta?.function);
  if (fromFunction) {
    return fromFunction;
  }

  const params = getMetaParams(message);
  if (!params) {
    return "";
  }

  try {
    const parsed = JSON.parse(params);
    return extractQuestionsFromValue(parsed);
  } catch {
    return "";
  }
}

function extractQuestionsFromToolFunction(toolFunction: unknown): string {
  if (!toolFunction || typeof toolFunction !== "object") {
    return "";
  }
  const args = (toolFunction as { arguments?: unknown }).arguments;
  if (typeof args !== "string" || !args.trim()) {
    return "";
  }
  try {
    const parsed = JSON.parse(args);
    return extractQuestionsFromValue((parsed as { questions?: unknown })?.questions);
  } catch {
    return "";
  }
}

function extractQuestionsFromValue(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return "";
      }
      return typeof (item as { question?: unknown }).question === "string"
        ? (item as { question: string }).question.trim()
        : "";
    })
    .filter(Boolean)
    .join(" / ");
}

function parseToolPayload(
  content: string | null
): { name: string | null; ok: boolean; metadata: Record<string, unknown> | null } {
  if (!content) {
    return { name: null, ok: true, metadata: null };
  }

  try {
    const parsed = JSON.parse(content) as { name?: unknown; ok?: unknown; metadata?: unknown };
    return {
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
      ok: parsed.ok !== false,
      metadata: isPlainRecord(parsed.metadata) ? parsed.metadata : null
    };
  } catch {
    return { name: null, ok: true, metadata: null };
  }
}

function getToolDiffPreviewLines(summary: ToolSummary): DiffPreviewLine[] {
  return [];
}

export function parseDiffPreview(diffPreview: string): DiffPreviewLine[] {
  return diffPreview
    .split("\n")
    .filter((line) => line && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("@@ "))
    .map((line) => {
      if (line.startsWith("+")) {
        return { marker: "+", content: line.slice(1), kind: "added" };
      }
      if (line.startsWith("-")) {
        return { marker: "-", content: line.slice(1), kind: "removed" };
      }
      return {
        marker: " ",
        content: line.startsWith(" ") ? line.slice(1) : line,
        kind: "context"
      };
    });
}

function DiffPreview({ lines }: { lines: DiffPreviewLine[] }): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor>└ Changes</Text>
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, index) => (
          <Text key={`${index}-${line.marker}-${line.content}`} wrap="truncate-end">
            <Text color={line.kind === "added" ? "green" : line.kind === "removed" ? "red" : "gray"}>
              {line.marker}
            </Text>
            <Text color={line.kind === "added" ? "green" : line.kind === "removed" ? "red" : undefined}>
              {line.content}
            </Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatStatusName(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "Tool";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function firstNonEmptyLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function getReasoningContent(message: SessionMessage): string | null {
  const params = message.messageParams as { reasoning_content?: string } | null | undefined;
  if (params && typeof params.reasoning_content === "string" && params.reasoning_content.trim()) {
    return params.reasoning_content.trim();
  }
  return null;
}


