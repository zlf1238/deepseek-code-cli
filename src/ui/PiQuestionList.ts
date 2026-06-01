/**
 * pi TUI 版本的提问列表组件。
 * 列出某个会话中所有用户提问（role === "user" 的消息），
 * 支持 ↑/↓ 切换、Enter 跳转到该提问位置、Esc/b 返回。
 * 复用 SelectList 组件，无搜索和删除模式。
 */
import type { SelectItem, SelectListTheme } from "../tui/components/select-list";
import { SelectList } from "../tui/components/select-list";
import type { Component } from "../tui/tui";
import { Theme } from "../tui/ThemeAdapter";
import { visibleWidth } from "../tui/utils";

/** 提问条目 */
export interface QuestionItem {
  /** 在全量消息数组中的索引（用于后续截断加载） */
  messageIndex: number;
  /** 显示序号 #1, #2, #3... */
  displayIndex: number;
  /** 提问内容摘要（已截断，用于列表显示） */
  content: string;
  /** 完整提问内容（用于预览行） */
  fullContent: string;
  /** 提问时间 */
  timestamp: string;
}

/** 组件主题 */
const questionListTheme: SelectListTheme = {
  selectedPrefix: Theme.selectedPrefix,
  selectedText: Theme.selectedText,
  description: Theme.description,
  scrollInfo: Theme.dimText,
  noMatch: Theme.dimText,
};

/** 将文本按指定可见宽度换行（支持中英文混合） */
function wrapText(text: string, lineWidth: number): string[] {
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (visibleWidth(remaining) <= lineWidth) {
      lines.push(remaining);
      break;
    }
    let hi = Math.min(remaining.length, lineWidth);
    let lo = 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (visibleWidth(remaining.slice(0, mid)) <= lineWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    lines.push(remaining.slice(0, lo));
    remaining = remaining.slice(lo);
  }
  return lines;
}

/** pi 版本的提问选择列表 */
export class PiQuestionList implements Component {
  private selectList: SelectList;
  private items: QuestionItem[] = [];
  private onSelectCb?: (messageIndex: number) => void;
  private onCancelCb?: () => void;

  constructor(maxVisible: number, termWidth?: number) {
    const maxCol = termWidth ? Math.max(30, Math.floor(termWidth * 0.9)) : 70;
    this.selectList = new SelectList({
      maxVisible: Math.max(3, maxVisible),
      layout: { minPrimaryColumnWidth: 15, maxPrimaryColumnWidth: maxCol },
      theme: questionListTheme,
    });
  }

  /** 设置提问数据 */
  setQuestions(newItems: QuestionItem[]): void {
    this.items = newItems;
    const selectItems: SelectItem[] = newItems.map((q) => ({
      value: String(q.messageIndex),
      label: `#${q.displayIndex}  ${q.content}`,
      description: q.timestamp,
    }));
    this.selectList.setItems(selectItems);
  }

  /** 选中回调：参数为 messageIndex */
  set onSelect(cb: (messageIndex: number) => void) {
    this.onSelectCb = cb;
    this.selectList.onSelect = (item) => {
      const idx = Number(item.value);
      if (!Number.isNaN(idx)) cb(idx);
    };
  }

  /** 取消回调 */
  set onCancel(cb: () => void) {
    this.onCancelCb = cb;
    this.selectList.onCancel = () => cb();
  }

  // ── Component 接口 ──

  render(width: number): string[] {
    const lines: string[] = [];
    const selItems = this.selectList.getItems();
    const idx = this.selectList.getSelectedIndex();

    // 预览区固定高度，避免切换条目时列表上下跳动
    const MIN_PREVIEW_LINES = 5;
    const MAX_PREVIEW_LINES = 5;
    const PREVIEW_CONTENT_LINES = MAX_PREVIEW_LINES - 1; // 标签占一行

    if (idx >= 0 && idx < selItems.length && idx < this.items.length) {
      const item = this.items[idx];
      const maxW = Math.max(10, width - 2);
      const raw = `#${item.displayIndex}  ${item.fullContent}`;

      // 标签行
      lines.push(Theme.dimText("  ── 提问预览 ──"));

      // 按可见宽度换行显示完整内容，超出上限则截断
      let wrapped = wrapText(raw, maxW);
      if (wrapped.length > PREVIEW_CONTENT_LINES) {
        wrapped = wrapped.slice(0, PREVIEW_CONTENT_LINES);
        wrapped[PREVIEW_CONTENT_LINES - 1] += " …";
      }
      for (const wl of wrapped) {
        lines.push(Theme.dimText(`  ${wl}`));
      }
      // 不足时用空行补齐，保持预览区总高度固定（标签 + MIN_PREVIEW_LINES 行）
      while (lines.length <= MIN_PREVIEW_LINES) {
        lines.push("");
      }
      // 分隔线
      const sepW = Math.min(width - 4, 30);
      lines.push(Theme.dimText("  " + "─".repeat(sepW)));
      lines.push("");
    }
    lines.push(...this.selectList.render(width));
    return lines;
  }

  handleInput(data: string): void {
    // b 键快速返回（与 Esc 同效）
    if (data === "b" || data === "B") {
      this.onCancelCb?.();
      return;
    }
    this.selectList.handleInput(data);
  }

  invalidate(): void {
    this.selectList.invalidate();
  }
}
