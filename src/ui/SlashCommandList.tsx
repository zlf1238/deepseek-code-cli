/** 斜杠命令菜单列表组件 */
import React from "react";
import { Box, Text } from "ink";
import type { SlashCommandItem } from "./slashCommands";
import { formatSlashCommandLabel, formatSlashCommandDescription } from "./slashCommands";

type Props = {
  items: SlashCommandItem[];
  selectedIndex: number;
  maxVisible?: number;
};

/**
 * 斜杠命令菜单列表。
 * 当用户在输入框中键入 / 时显示可用的命令和技能列表。
 */
export function SlashCommandList({
  items,
  selectedIndex,
  maxVisible = 12,
}: Props): React.ReactElement | null {
  if (items.length === 0) return null;

  const visible = items.slice(0, maxVisible);
  const hidden = items.length - maxVisible;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map((item, idx) => (
        <Text
          key={item.label}
          color={idx === selectedIndex ? "cyanBright" : undefined}
          wrap="truncate-end"
        >
          {idx === selectedIndex ? "► " : "  "}
          <Text bold>{formatSlashCommandLabel(item)}</Text>
          <Text dimColor>  {formatSlashCommandDescription(item.description)}</Text>
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>… 还有 {hidden} 个已隐藏</Text>
      ) : null}
    </Box>
  );
}
