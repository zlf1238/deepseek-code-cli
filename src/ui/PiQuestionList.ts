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

/** 提问条目 */
export interface QuestionItem {
  /** 在全量消息数组中的索引（用于后续截断加载） */
  messageIndex: number;
  /** 显示序号 #1, #2, #3... */
  displayIndex: number;
  /** 提问内容摘要（已截断） */
  content: string;
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

/** pi 版本的提问选择列表 */
export class PiQuestionList implements Component {
  private selectList: SelectList;
  private onSelectCb?: (messageIndex: number) => void;
  private onCancelCb?: () => void;

  constructor(maxVisible: number) {
    this.selectList = new SelectList({
      maxVisible: Math.max(3, maxVisible),
      layout: { minPrimaryColumnWidth: 15, maxPrimaryColumnWidth: 55 },
      theme: questionListTheme,
    });
  }

  /** 设置提问数据 */
  setQuestions(items: QuestionItem[]): void {
    const selectItems: SelectItem[] = items.map((q) => ({
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
    return this.selectList.render(width);
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
