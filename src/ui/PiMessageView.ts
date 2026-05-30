/**
 * pi TUI 版本的消息视图组件。
 * 复用项目现有的 Markdown 渲染器，完整支持：标题、列表、代码块、粗体/斜体、表格、引用。
 * 支持：用户/assistant/tool/system 消息、步骤指示器、思考过程摘要。
 */
import { Text } from "../tui/components/text";
import { Spacer } from "../tui/components/spacer";
import type { Container } from "../tui/tui";
import { Box } from "../tui/components/box";
import { renderMarkdown } from "./markdown";
import { Theme, type ColorFn } from "../tui/ThemeAdapter";

/** 消息角色 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** 消息 meta（从 SessionMessage.meta 提取） */
export type MessageMeta = {
  asThinking?: boolean;
  isSummary?: boolean;
  isStepIndicator?: boolean;
  stepDescription?: string;
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  statusColor?: string;
  isToolGroup?: boolean;
};

/** 创建消息视图组件 */
export function createMessageView(
  content: string,
  role: MessageRole,
  width: number,
  meta?: MessageMeta,
): Container {
  const box = new Box(0, 0);

  if (!content.trim() && !meta?.isStepIndicator) {
    return box;
  }

  // ── 步骤指示器（无 ● 前缀，灰色） ──
  if (meta?.isStepIndicator) {
    box.addChild(new Text(Theme.dimText(`  ${content}`), 0, 0));
    return box;
  }

  // ── 思考过程（折叠显示摘要） ──
  if (meta?.asThinking) {
    box.addChild(new Text(Theme.dimText(`  ▸ 思考过程`), 0, 0));
    if (content.trim()) {
      const rendered = renderMarkdown(content, width - 4);
      const lines = rendered.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          box.addChild(new Text(`    ${line}`, 0, 0, Theme.dimText));
        } else {
          box.addChild(new Spacer(1));
        }
      }
    }
    return box;
  }

  // ── 工具归组摘要 ──
  if (meta?.isToolGroup) {
    box.addChild(new Text(Theme.dimText(`  ${content}`), 0, 0));
    return box;
  }

  // ── 摘要消息（使用 statusColor 着色） ──
  if (meta?.isSummary) {
    const colorFn = summaryColorFn(meta.statusColor);
    box.addChild(new Text(content, 0, 0, colorFn));
    return box;
  }

  // ── 用户消息（全部绿色） ──
  if (role === "user") {
    const rendered = renderMarkdown(content, width);
    const lines = rendered.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        const linePrefix = i === 0 ? "❯ " : "  ";
        box.addChild(new Text(`${linePrefix}${lines[i]}`, 0, 0, Theme.userText));
      } else {
        box.addChild(new Spacer(1));
      }
    }
    return box;
  }

  // ── 助手消息 ──
  if (role === "assistant") {
    // 工具调用消息 — 提取工具名和参数
    if (meta?.function || meta?.paramsMd) {
      const toolSummary = buildToolSummary(meta, content);
      // 状态行
      const bullet = toolSummary.ok ? "✓" : "✗";
      const bulletColor = toolSummary.ok ? Theme.selectedPrefix : Theme.errorText;
      box.addChild(new Text(
        `${bulletColor(bullet)} ${Theme.boldText(Theme.cyanText(toolSummary.name))}  ${toolSummary.params}`,
        0, 0,
      ));
      // 工具结果摘要
      if (toolSummary.result && toolSummary.result.trim()) {
        const rendered = renderMarkdown(toolSummary.result, width - 4);
        const lines = rendered.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            box.addChild(new Text(`    ${line}`, 0, 0));
          } else {
            box.addChild(new Spacer(1));
          }
        }
      }
      return box;
    }

    // 普通 assistant 消息
    const rendered = renderMarkdown(content, width - 2);
    const lines = rendered.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) {
        const isTable = isTableBorderLine(lines[i]);
        const linePrefix = isTable ? "" : (i === 0 ? Theme.cyanText("● ") : "  ");
        box.addChild(new Text(`${linePrefix}${lines[i]}`, 0, 0));
      } else {
        box.addChild(new Spacer(1));
      }
    }
    return box;
  }

  // ── 系统/其他消息 ──
  const rendered = renderMarkdown(content, width - 2);
  const lines = rendered.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      const isTable = isTableBorderLine(lines[i]);
      const linePrefix = isTable ? "" : (i === 0 ? Theme.dimText("· ") : "  ");
      box.addChild(new Text(`${linePrefix}${lines[i]}`, 0, 0, Theme.dimText));
    } else {
      box.addChild(new Spacer(1));
    }
  }
  return box;
}

// ── 工具消息摘要 ──

type ToolSummary = {
  name: string;
  params: string;
  result: string;
  ok: boolean;
};

function buildToolSummary(meta: MessageMeta, content: string): ToolSummary {
  const name = getToolName(meta) || "Tool";
  const params = meta.paramsMd?.trim() || "";
  const result = meta.resultMd?.trim() || content || "";
  const ok = !result.toLowerCase().includes("error") && !result.toLowerCase().includes("fail");
  return { name: formatToolName(name), params: truncate(params, 120), result, ok };
}

function getToolName(meta: MessageMeta): string {
  const fn = meta.function as { name?: string } | undefined;
  if (fn?.name) return fn.name;
  return "";
}

function formatToolName(name: string): string {
  if (!name) return "Tool";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

// ── 表格行检测 ──

/** Unicode 制表符集合：渲染后的表格行以这些字符开头 */
const TABLE_LINE_CHARS = new Set(["│", "├", "└", "┌", "┬", "┴", "┼", "┤"]);

/** 完成摘要统一使用黄色 */
function summaryColorFn(_status?: string): ColorFn {
  return Theme.warnText;
}

/** 剥离 ANSI 转义码（如 chalk.dim 产生的 \x1b[2m） */
const STRIP_ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 判断一行是否是渲染后的 Markdown 表格行（边框线或数据行），
 *  这些行不应添加消息前缀以保持边框对齐。
 *  注意：渲染后的表格行可能以 ANSI 转义码开头（如 dim 边框色），需先剥离再判断。 */
function isTableBorderLine(line: string): boolean {
  const visible = line.replace(STRIP_ANSI_RE, "");
  const first = visible[0];
  return first !== undefined && TABLE_LINE_CHARS.has(first);
}
