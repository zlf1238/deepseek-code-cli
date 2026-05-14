import React, { useMemo, useState } from "react";
import { Box, Text } from "ink";
import * as os from "os";
import * as path from "path";
import type { SkillInfo } from "../session";
import { getContextWindowCapacity } from "../model-capabilities";
import type { ResolvedDeepcodingSettings } from "../settings";
import {
  BUILTIN_SLASH_COMMANDS,
  buildSlashCommands,
  formatSlashCommandDescription
} from "./slashCommands";

type WelcomeScreenProps = {
  projectRoot: string;
  settings: ResolvedDeepcodingSettings;
  skills: SkillInfo[];
  version: string;
  width: number;
};

const TITLE_PANEL_WIDTH = 30;
const PANEL_CONTENT_HEIGHT = 7;
const SEPARATOR_LINES = 12;

const SHORTCUT_TIPS = [
  { label: "Enter", description: "发送消息" },
  { label: "Shift+Enter", description: "插入换行" },
  { label: "Ctrl+V", description: "从剪贴板粘贴图片" },
  { label: "Esc", description: "中断当前回复" },
  { label: "/", description: "打开技能和命令菜单" },
  { label: "Ctrl+D 两次", description: "退出 DeepSeek Code CLI" }
];

export function WelcomeScreen({
  projectRoot,
  settings,
  skills,
  version,
  width
}: WelcomeScreenProps): React.ReactElement {
  const tips = useMemo(() => buildWelcomeTips(skills), [skills]);
  const [tipIndex] = useState(() => randomTipIndex(tips.length));
  const compact = width < TITLE_PANEL_WIDTH + 42;
  const cwd = formatHomeRelativePath(projectRoot);
  const contextWindowCapacity = getContextWindowCapacity(settings.model);
  const tip = tips[Math.min(tipIndex, Math.max(0, tips.length - 1))] ?? tips[0];
  const panelWidth = compact ? undefined : Math.min(width, 92);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" width={panelWidth}>
        <Box flexDirection={compact ? "column" : "row"} paddingX={1}>
          <Box
            flexDirection="column"
            minHeight={PANEL_CONTENT_HEIGHT}
            justifyContent="center"
            width={compact ? undefined : TITLE_PANEL_WIDTH}
          >
            <Box justifyContent="center" width={compact ? undefined : TITLE_PANEL_WIDTH}>
              <Text bold color="cyanBright">
                DeepSeek Code
              </Text>
              <Text> (v{version || "unknown"})</Text>
            </Box>
          </Box>

          {!compact ? (
            <Box flexDirection="column" marginX={1}>
              {Array.from({ length: SEPARATOR_LINES }, (_, index) => (
                <Text key={index} color="cyan">
                  │
                </Text>
              ))}
            </Box>
        ) : null}

          <Box
            flexDirection="column"
            flexGrow={1}
            marginTop={compact ? 1 : 0}
          >
            {!compact ? <Text> </Text> : null}
            <SettingRow label="model" value={`${settings.model}${settings.mode !== "auto" ? ` (${settings.mode})` : ""}`} />
            <SettingRow label="thinking enabled" value={String(settings.thinkingEnabled)} />
            <SettingRow label="reasoning effort" value={settings.reasoningEffort} />
            <SettingRow label="context window" value={formatTokenCount(contextWindowCapacity)} />
            <SettingRow label="cwd" value={cwd} />
            {!compact ? <Text> </Text> : null}
          </Box>
        </Box>
      </Box>

      {tip ? (
        <Box marginTop={1}>
          <Text dimColor>
            Tips: {tip.label} - {tip.description}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SettingRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box width={20}>
        <Text>{label}</Text>
      </Box>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    </Box>
  );
}

export function formatHomeRelativePath(value: string, home = os.homedir()): string {
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const relative = path.relative(normalizedHome, normalizedValue);

  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~${path.sep}${relative}`;
  }
  return normalizedValue;
}

export function buildWelcomeTips(skills: SkillInfo[]): Array<{ label: string; description: string }> {
  const slashTips = buildSlashCommands(skills)
    .filter((item) => item.kind !== "skill" || item.skill?.isLoaded)
    .map((item) => ({
      label: item.label,
      description: formatSlashCommandDescription(item.description)
    }));

  return [
    ...slashTips,
    ...SHORTCUT_TIPS.filter((tip) => !BUILTIN_SLASH_COMMANDS.some((command) => command.label === tip.label))
  ];
}

function randomTipIndex(length: number): number {
  return length > 0 ? Math.floor(Math.random() * length) : 0;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}
