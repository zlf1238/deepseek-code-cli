import type { SkillInfo } from "../session";

export type SlashCommandKind = "skill" | "skills" | "model" | "thinking" | "autoSwitch" | "verbose" | "new" | "resume" | "exit" | "learn" | "worklog";

export type SlashCommandItem = {
  kind: SlashCommandKind;
  name: string;
  label: string;
  description: string;
  skill?: SkillInfo;
};

export const BUILTIN_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    kind: "new",
    name: "new",
    label: "/new",
    description: "开始新对话"
  },
  {
    kind: "resume",
    name: "resume",
    label: "/resume",
    description: "恢复历史对话"
  },
  {
    kind: "skills",
    name: "skills",
    label: "/skills",
    description: "查看可用技能列表"
  },
  {
    kind: "model",
    name: "model",
    label: "/model",
    description: "切换当前模型"
  },
  {
    kind: "thinking",
    name: "thinking",
    label: "/thinking",
    description: "切换思考模式（开启/关闭）"
  },
  {
    kind: "autoSwitch",
    name: "autoSwitch",
    label: "/autoSwitch",
    description: "开启/关闭自动切换模型"
  },
  {
    kind: "verbose",
    name: "verbose",
    label: "/verbose",
    description: "开启/关闭详细模式（展示思考过程和工具调用历史）"
  },
  {
    kind: "exit",
    name: "exit",
    label: "/exit",
    description: "退出 DeepSeek Code CLI"
  },
  {
    kind: "learn",
    name: "learn",
    label: "/learn",
    description: "从本轮对话的错误中学习，总结并写入 AGENTS.md"
  },
  {
    kind: "worklog",
    name: "worklog",
    label: "/worklog",
    description: "总结本轮对话的决策过程，生成工作日志到 docs/developers/worklogs"
  },

];

export function buildSlashCommands(skills: SkillInfo[]): SlashCommandItem[] {
  const skillItems: SlashCommandItem[] = skills.map((skill) => ({
    kind: "skill",
    name: skill.name,
    label: `/${skill.name}`,
    description: skill.description || "(no description)",
    skill
  }));
  return [...skillItems, ...BUILTIN_SLASH_COMMANDS];
}

export function filterSlashCommands(
  items: SlashCommandItem[],
  token: string
): SlashCommandItem[] {
  if (!token.startsWith("/")) {
    return [];
  }
  const query = token.slice(1).toLowerCase();
  if (!query) {
    // 裸 / 只显示内置命令（/new /resume /skills /model /thinking /exit），
    // 不显示技能项。输入字母后才展示匹配的技能，减少终端布局波动
    // 从而避免回滚缓冲区中的旧对话消息被滚动暴露
    return items.filter((item) => item.kind !== "skill");
  }
  return items.filter((item) => item.name.toLowerCase().includes(query));
}

export function findExactSlashCommand(
  items: SlashCommandItem[],
  token: string
): SlashCommandItem | null {
  if (!token.startsWith("/")) {
    return null;
  }
  const query = token.slice(1);
  const matches = items.filter((item) => item.name === query);
  return matches.find((item) => item.kind !== "skill") ?? matches[0] ?? null;
}

export function formatSlashCommandDescription(description: string): string {
  return (description || "(no description)").trim().replace(/\s+/g, " ");
}

export function formatSlashCommandLabel(item: SlashCommandItem): string {
  return item.kind === "skill" && item.skill?.isLoaded ? `${item.label} ✓` : item.label;
}
