import React from "react";
import { Box, Text } from "ink";

type ShortcutEntry = {
  keys: string;
  description: string;
};

const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Enter", description: "发送消息" },
  { keys: "Shift+Enter", description: "插入换行" },
  { keys: "↑/↓", description: "浏览输入历史" },
  { keys: "←/→", description: "光标移动" },
  { keys: "Home/End", description: "行首/行尾" },
  { keys: "Ctrl+←/→", description: "按词移动" },
  { keys: "Ctrl+W", description: "删除前一个词" },
  { keys: "Ctrl+V", description: "粘贴剪贴板图片" },
  { keys: "Esc", description: "中断当前回复" },
  { keys: "?", description: "显示/关闭此帮助" },
  { keys: "/", description: "打开技能和命令菜单" },
  { keys: "/new", description: "开始新对话" },
  { keys: "/resume", description: "恢复历史对话" },
  { keys: "/verbose", description: "切换详细模式" },
  { keys: "/model", description: "切换模型" },
  { keys: "/thinking", description: "切换思考模式" },
  { keys: "Ctrl+D 两次", description: "退出" },
];

type Props = {
  onClose: () => void;
};

export function HelpOverlay({ onClose }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Box marginBottom={1}>
        <Text bold color="cyanBright">快捷键帮助</Text>
      </Box>
      {SHORTCUTS.map((shortcut, index) => (
        <Box key={index} flexDirection="row" marginY={0}>
          <Box width={20}>
            <Text bold wrap="truncate-end">{shortcut.keys}</Text>
          </Box>
          <Text dimColor>{shortcut.description}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>按 Esc 或 ? 关闭此面板</Text>
      </Box>
    </Box>
  );
}
