/**
 * pi TUI 版本的斜杠命令列表组件。
 * 使用 pi 的 SelectList 渲染，纯展示无交互（选择和取消由父组件处理）。
 */
import type { Component } from "../tui/tui";
import type { SelectItem } from "../tui/components/select-list";
import { SelectList } from "../tui/components/select-list";
import type { SlashCommandItem } from "./slashCommands";
import { formatSlashCommandLabel, formatSlashCommandDescription } from "./slashCommands";
import { Theme } from "../tui/ThemeAdapter";

/** 创建斜杠命令选择列表组件 */
export function createSlashCommandList(
  items: SlashCommandItem[],
  selectedIndex: number,
  maxVisible = 12,
): Component {
  const list = new SelectList({
    maxVisible,
    theme: {
      selectedPrefix: Theme.selectedPrefix,
      selectedText: Theme.selectedText,
      description: Theme.description,
      scrollInfo: Theme.dimText,
      noMatch: Theme.dimText,
    },
  });

  // 映射 SlashCommandItem → SelectItem 并设置
  const selectItems: SelectItem[] = items.map((item) => ({
    value: item.label,
    label: formatSlashCommandLabel(item),
    description: formatSlashCommandDescription(item.description),
  }));

  list.setItems(selectItems);
  list.setSelectedIndex(selectedIndex);

  return list;
}
