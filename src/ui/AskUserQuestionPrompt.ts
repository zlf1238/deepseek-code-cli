/**
 * pi TUI 版本的 AskUserQuestionPrompt 组件。
 * 支持：多问题、多选、自定义文本输入 ("Other")、Tab 切换问题。
 *
 * 问题类型来自 ../session 中的 AskUserQuestionItem。
 */
import type { AskUserQuestionItem, AskUserQuestionAnswers } from "./askUserQuestion";
import { SelectList } from "../tui/components/select-list";
import type { SelectItem, SelectListTheme } from "../tui/components/select-list";
import { Input } from "../tui/components/input";
import { Text } from "../tui/components/text";
import { Box } from "../tui/components/box";
import { Spacer } from "../tui/components/spacer";
import type { Component, Container } from "../tui/tui";
import { Theme } from "../tui/ThemeAdapter";

type Mode = "select" | "input";

const theme: SelectListTheme = {
  selectedPrefix: Theme.selectedPrefix,
  selectedText: Theme.selectedText,
  description: Theme.description,
  scrollInfo: Theme.dimText,
  noMatch: Theme.dimText,
};

export class AskUserQuestionPrompt implements Component {
  private questions: AskUserQuestionItem[] = [];
  private questionIndex = 0;
  private cursorIndex = 0;
  private answers: AskUserQuestionAnswers = {};
  private multiSelected: Record<number, string[]> = {};
  private otherTexts: Record<number, string> = {};
  private mode: Mode = "select";
  private otherInput: Input;
  private onSubmitCb?: (answers: AskUserQuestionAnswers) => void;
  private onCancelCb?: () => void;

  constructor() {
    this.otherInput = new Input();
    this.otherInput.onSubmit = (value) => this.submitOtherText(value);
    this.otherInput.onEscape = () => { this.mode = "select"; };
  }

  setQuestions(questions: AskUserQuestionItem[]): void {
    this.questions = questions;
    this.questionIndex = 0;
    this.cursorIndex = 0;
    this.answers = {};
    this.multiSelected = {};
    this.otherTexts = {};
    this.mode = "select";
  }

  set onSubmit(cb: (answers: AskUserQuestionAnswers) => void) {
    this.onSubmitCb = cb;
  }

  set onCancel(cb: () => void) {
    this.onCancelCb = cb;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const question = this.questions[this.questionIndex];
    if (!question) {
      lines.push(Theme.dimText("  无问题"));
      return lines;
    }

    // 问题标签页
    const tabLine = this.questions.map((q, i) => {
      const answered = Boolean(this.answers[q.question]);
      const label = ` ${answered ? "✓" : "□"} Q${i + 1} `;
      if (i === this.questionIndex) return chalkInverse(label);
      if (answered) return chalkGreen(label);
      return label;
    }).join("");
    lines.push(tabLine);
    lines.push("");

    // 问题文本
    lines.push(Theme.boldText(`  ${question.question}`));
    lines.push("");

    // 选项列表
    const options = this.buildOptions(question);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === this.cursorIndex;
      const isChecked = question.multiSelect && this.multiSelected[this.questionIndex]?.includes(opt.value);
      const prefix = isSelected ? "→ " : "  ";
      const check = isChecked ? "[✓] " : question.multiSelect ? "[ ] " : "";
      const label = `${prefix}${check}${opt.label}`;
      lines.push(isSelected ? Theme.selectedText(label) : label);

      if (opt.description) {
        lines.push(`      ${Theme.description(opt.description)}`);
      }
    }

    // Other 输入
    if (this.mode === "input") {
      lines.push("");
      lines.push(Theme.dimText("  输入自定义答案 (Enter 确认, Esc 返回):"));
      const inputLines = this.otherInput.render(width - 2);
      for (const l of inputLines) {
        lines.push(`  ${l}`);
      }
    } else {
      lines.push("");
      lines.push(Theme.dimText(
        question.multiSelect
          ? "↑/↓ 移动 · Space 切换选择 · Enter 下一个问题 · Tab/→ 下一个 · ← 上一个 · Esc 取消"
          : "↑/↓ 移动 · Enter 选择/下一个 · Tab/→ 下一个 · ← 上一个 · Esc 取消"
      ));
    }

    return lines;
  }

  handleInput(data: string): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;

    // Other 输入模式
    if (this.mode === "input") {
      this.otherInput.handleInput(data);
      return;
    }

    const options = this.buildOptions(question);

    // Esc: 取消
    if (data === "\x1b") { this.onCancelCb?.(); return; }
    // Ctrl+C: 取消
    if (data === "\x03") { this.onCancelCb?.(); return; }

    // Tab/右箭头: 下一个问题
    if (data === "\t" || data === "\x1b[C") {
      this.moveQuestion(1); return;
    }
    // 左箭头: 上一个问题
    if (data === "\x1b[D") {
      this.moveQuestion(-1); return;
    }

    // ↑
    if (data === "\x1b[A") {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1); return;
    }
    // ↓
    if (data === "\x1b[B") {
      this.cursorIndex = Math.min(options.length - 1, this.cursorIndex + 1); return;
    }

    // Space: 多选切换
    if (data === " " && question.multiSelect) {
      this.toggleMultiSelect(); return;
    }

    // Enter: 确认/进入 Other 输入
    if (data === "\r") {
      const opt = options[this.cursorIndex];
      if (opt?.isOther) {
        this.mode = "input";
        this.otherInput.setValue(this.otherTexts[this.questionIndex] ?? "");
        return;
      }
      this.confirmAnswer(opt); return;
    }
  }

  invalidate(): void {
    this.otherInput.invalidate();
  }

  // ── 内部 ──

  private buildOptions(question: AskUserQuestionItem): Array<{ label: string; description?: string; value: string; isOther?: boolean }> {
    return [
      ...question.options.map(o => ({ label: o.label, description: o.description, value: o.label })),
      { label: "Other", value: "__other__", isOther: true },
    ];
  }

  private moveQuestion(delta: number): void {
    const newIdx = this.questionIndex + delta;
    if (newIdx < 0 || newIdx >= this.questions.length) return;
    this.questionIndex = newIdx;
    this.cursorIndex = 0;
    this.mode = "select";
  }

  private toggleMultiSelect(): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;
    const options = this.buildOptions(question);
    const opt = options[this.cursorIndex];
    if (!opt || opt.isOther) return;

    const selected = this.multiSelected[this.questionIndex] ?? [];
    const idx = selected.indexOf(opt.value);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(opt.value);
    this.multiSelected[this.questionIndex] = selected;
  }

  private confirmAnswer(opt?: { label: string; value: string; isOther?: boolean }): void {
    const question = this.questions[this.questionIndex];
    if (!question) return;

    if (question.multiSelect) {
      const selected = this.multiSelected[this.questionIndex] ?? [];
      const otherText = this.otherTexts[this.questionIndex]?.trim();
      const labels = selected.filter(v => v !== "__other__");
      if (otherText) labels.push(otherText);
      if (labels.length > 0) {
        this.answers[question.question] = labels.join(", ");
      }
    } else if (opt) {
      this.answers[question.question] = opt.label;
    }

    // 移到下一个问题或提交
    if (this.questionIndex < this.questions.length - 1) {
      this.moveQuestion(1);
    } else {
      this.onSubmitCb?.(this.answers);
    }
  }

  private submitOtherText(value: string): void {
    this.otherTexts[this.questionIndex] = value;
    this.mode = "select";
  }
}

// chalk 等价函数
function chalkInverse(s: string): string { return `\x1b[7m${s}\x1b[27m`; }
function chalkGreen(s: string): string { return `\x1b[32m${s}\x1b[39m`; }
