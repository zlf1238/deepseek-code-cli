/**
 * pi TUI 版本的 ModeBar — 验证 pi 差分渲染管道可用。
 * 简单地渲染一个带背景色的状态行。
 */
import { Component } from "../tui/tui";
import { Box } from "../tui/components/box";
import { Text } from "../tui/components/text";
import { Theme } from "../tui/ThemeAdapter";

/** 创建一个 pi TUI 版本的 ModeBar 组件 */
export function createModeBar(model: string, busy: boolean): Component {
  const box = new Box(1, 0, Theme.barBg);
  if (busy) {
    box.addChild(new Text(`⏳ ${model} — 执行中...`, 0, 0));
  }
  return box;
}
