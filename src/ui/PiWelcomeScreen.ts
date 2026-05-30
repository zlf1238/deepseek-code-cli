/**
 * pi TUI 版本的欢迎屏组件。
 * 显示项目信息、设置摘要、随机提示。纯展示，无交互。
 */
import * as os from "os";
import * as path from "path";
import { Box } from "../tui/components/box";
import { Text } from "../tui/components/text";
import { Spacer } from "../tui/components/spacer";
import type { Container } from "../tui/tui";
import type { SkillInfo } from "../session";
import { getContextWindowCapacity } from "../model-capabilities";
import type { ResolvedDeepcodingSettings } from "../settings";
import {
  BUILTIN_SLASH_COMMANDS,
  buildSlashCommands,
  formatSlashCommandDescription,
} from "./slashCommands";
import { Theme } from "../tui/ThemeAdapter";

type Tip = { label: string; description: string };

const SHORTCUT_TIPS: Tip[] = [
  { label: "Enter", description: "发送消息" },
  { label: "Shift+Enter", description: "插入换行" },
  { label: "Ctrl+V", description: "从剪贴板粘贴图片" },
  { label: "Esc", description: "中断当前回复" },
  { label: "/", description: "打开技能和命令菜单" },
  { label: "Ctrl+D 两次", description: "退出 DeepSeek Code CLI" },
];

/** 创建欢迎屏组件 */
export function createWelcomeScreen(
  projectRoot: string,
  settings: ResolvedDeepcodingSettings,
  skills: SkillInfo[],
  version: string,
  width: number,
  verboseMode: boolean,
): Container {
  const box = new Box(1, 0);
  const tips = buildWelcomeTips(skills);
  const tip = tips[Math.floor(Math.random() * tips.length)] ?? tips[0];
  const cwd = formatHomeRelativePath(projectRoot);
  const ctxCapacity = getContextWindowCapacity(settings.model);

  // 窄屏模式
  if (width <= 32) {
    box.addChild(new Text("DeepSeek Code CLI", 0, 0, Theme.boldText));
    if (tip) {
      box.addChild(new Text(`${tip.label} - ${tip.description}`, 0, 0, Theme.dimText));
    }
    return box;
  }

  // 标准模式
  box.addChild(new Text("DeepSeek Code CLI", 0, 0, Theme.boldText));
  box.addChild(new Spacer(1));

  // 设置摘要
  box.addChild(new Text(`  model     ${settings.model}${settings.mode !== "auto" ? ` (${settings.mode})` : ""}`, 0, 0));
  box.addChild(new Text(`  thinking  ${settings.thinkingEnabled}`, 0, 0));
  box.addChild(new Text(`  effort    ${settings.reasoningEffort}`, 0, 0));
  box.addChild(new Text(`  ctx win   ${formatTokenCount(ctxCapacity)}`, 0, 0));
  box.addChild(new Text(`  cwd       ${cwd}`, 0, 0));
  box.addChild(new Text(`  verbose   ${verboseMode}`, 0, 0));
  box.addChild(new Spacer(1));

  // Tips
  if (tip) {
    box.addChild(new Text(`Tips: ${tip.label} - ${tip.description}`, 0, 0, Theme.dimText));
  }

  return box;
}

// ── 工具函数 ──

export function formatHomeRelativePath(value: string, home = os.homedir()): string {
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const relative = path.relative(normalizedHome, normalizedValue);
  if (relative === "") return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `~${path.sep}${relative}`;
  return normalizedValue;
}

export function buildWelcomeTips(skills: SkillInfo[]): Tip[] {
  const slashTips = buildSlashCommands(skills)
    .filter((item) => item.kind !== "skill" || item.skill?.isLoaded)
    .map((item) => ({
      label: item.label,
      description: formatSlashCommandDescription(item.description),
    }));
  return [
    ...slashTips,
    ...SHORTCUT_TIPS.filter((tip) => !BUILTIN_SLASH_COMMANDS.some((c) => c.label === tip.label)),
  ];
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}
