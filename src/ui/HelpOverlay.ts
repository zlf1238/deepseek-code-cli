/**
 * pi TUI 版本的帮助面板组件。
 * 纯展示，无交互。
 */
import { Box } from "../tui/components/box";
import { Text } from "../tui/components/text";
import { Spacer } from "../tui/components/spacer";
import type { Component, Container } from "../tui/tui";
import { Theme } from "../tui/ThemeAdapter";

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
  { keys: "Ctrl+H / ?", description: "显示/关闭此帮助" },
  { keys: "/", description: "打开技能和命令菜单" },
  { keys: "/new", description: "开始新对话" },
  { keys: "/resume", description: "恢复历史对话" },
  { keys: "/verbose", description: "切换详细模式" },
  { keys: "/model", description: "切换模型" },
  { keys: "/thinking", description: "切换思考模式" },
  { keys: "Ctrl+D 两次", description: "退出" },
];

/** 创建帮助面板组件。需要包装在 Container 中并通过 overlay 显示。 */
export function createHelpOverlay(): Container {
  const box = new Box(1, 1);

  // 标题
  box.addChild(new Text("快捷键帮助", 0, 0, Theme.boldText));
  box.addChild(new Spacer(1));

  // 快捷键列表
  for (const shortcut of SHORTCUTS) {
    const padding = " ".repeat(Math.max(0, 22 - shortcut.keys.length));
    box.addChild(new Text(`${shortcut.keys}${padding}${shortcut.description}`, 0, 0, Theme.dimText));
  }

  box.addChild(new Spacer(1));
  box.addChild(new Text("按 Esc 或 Ctrl+H 关闭此面板", 0, 0, Theme.dimText));

  return box;
}
