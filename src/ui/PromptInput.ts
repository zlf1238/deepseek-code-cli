/**
 * pi TUI 版本的输入框组件。
 * 功能：输入历史浏览 (↑/↓)、斜杠命令检测、Enter 提交、Esc 取消。
 */
import { Input } from "../tui/components/input";
import type { Component, Focusable } from "../tui/tui";

/** 斜杠命令信息 */
export interface SlashContext {
  /** 当前斜杠 token（如 "/res" 中的 "res"） */
  token: string | null;
  /** 完整的输入 buffer */
  buffer: string;
}

/** 输入提交信息 */
export interface PromptSubmission {
  text: string;
  /** 是否匹配了斜杠命令 */
  slashCommand?: { kind: string; label: string };
}

export class PromptInput implements Component, Focusable {
  private input: Input;
  private history: string[] = [];
  private historyIndex = -1;
  private draftBeforeHistory: string | null = null;
  private onSubmitCb?: (submission: PromptSubmission) => void;
  private onCancelCb?: () => void;
  private onSlashChangeCb?: (ctx: SlashContext) => void;

  /** Focusable 接口 */
  focused = false;

  constructor() {
    this.input = new Input();
    this.input.onSubmit = (value) => this.handleSubmit(value);
    this.input.onEscape = () => this.onCancelCb?.();
  }

  /** 提交回调 */
  set onSubmit(cb: (submission: PromptSubmission) => void) {
    this.onSubmitCb = cb;
  }

  /** 取消回调 */
  set onCancel(cb: () => void) {
    this.onCancelCb = cb;
  }

  /** 斜杠命令变化回调（用于父组件显示命令列表） */
  set onSlashChange(cb: (ctx: SlashContext) => void) {
    this.onSlashChangeCb = cb;
  }

  /** 获取当前输入值 */
  get value(): string {
    return this.input.getValue();
  }

  /** 设置输入值（并通知斜杠变化） */
  setValue(text: string): void {
    this.input.setValue(text);
    this.notifySlashChange();
  }

  /** 清除输入 */
  clear(): void {
    this.input.setValue("");
    this.notifySlashChange();
  }

  /** 添加一条输入到历史 */
  addHistory(entry: string): void {
    if (entry.trim() && this.history[this.history.length - 1] !== entry) {
      this.history.push(entry);
    }
  }

  // ── Component 接口 ──

  render(width: number): string[] {
    return this.input.render(width);
  }

  handleInput(data: string): void {
    // 多行输入时，上下箭头用于行内移动（非历史浏览）
    const isMultiLine = this.input.getValue().includes("\n");

    if (data === "\x1b[A") {
      if (isMultiLine) {
        // 多行模式：交给 Input 处理（上移一行）
        this.input.handleInput(data);
        return;
      }
      // 单行模式：浏览历史
      this.navigateHistory(1);
      return;
    }
    if (data === "\x1b[B") {
      if (isMultiLine) {
        this.input.handleInput(data);
        return;
      }
      this.navigateHistory(-1);
      return;
    }

    // Ctrl+J 插入换行（多行输入），或 Kitty Shift+Enter
    if (data === "\n" || data === "\x1b[13;2u") {
      const val = this.input.getValue();
      this.input.setValue(val + "\n");
      this.notifySlashChange();
      return;
    }

    // 代理给底层 Input
    this.input.handleInput(data);

    // 通知斜杠变化
    this.notifySlashChange();

    // 如果不在浏览历史，重置
    if (data !== "\x1b[A" && data !== "\x1b[B") {
      if (this.historyIndex >= 0) {
        this.historyIndex = -1;
        this.draftBeforeHistory = null;
      }
    }
  }

  invalidate(): void {
    this.input.invalidate();
  }

  // ── 内部方法 ──

  private handleSubmit(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;

    // 添加到历史
    this.addHistory(trimmed);
    this.historyIndex = -1;
    this.draftBeforeHistory = null;

    // 检测斜杠命令
    const slashMatch = /^\/(\S*)/.exec(trimmed);
    const submission: PromptSubmission = { text: trimmed };
    if (slashMatch) {
      submission.slashCommand = { kind: "slash", label: slashMatch[0] };
    }

    this.onSubmitCb?.(submission);
  }

  private navigateHistory(direction: 1 | -1): void {
    if (this.history.length === 0) return;

    // 开始浏览历史时，保存当前草稿
    if (this.historyIndex === -1) {
      this.draftBeforeHistory = this.input.getValue();
      this.historyIndex = 0;
    }

    const newIndex = this.historyIndex + direction;
    if (newIndex < 0) {
      // 回到草稿
      this.historyIndex = -1;
      this.input.setValue(this.draftBeforeHistory ?? "");
      this.draftBeforeHistory = null;
      this.notifySlashChange();
      return;
    }

    this.historyIndex = Math.min(newIndex, this.history.length - 1);
    const entry = this.history[this.history.length - 1 - this.historyIndex];
    if (entry !== undefined) {
      this.input.setValue(entry);
      this.notifySlashChange();
    }
  }

  private notifySlashChange(): void {
    if (!this.onSlashChangeCb) return;
    const buffer = this.input.getValue();
    const match = /^\/(\S*)/.exec(buffer);
    this.onSlashChangeCb({
      token: match ? match[1] : null,
      buffer,
    });
  }
}
