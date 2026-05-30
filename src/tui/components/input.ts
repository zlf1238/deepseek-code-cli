// keybindings stub — 使用内联按键检测
// keys stub — Kitty 协议不支持，内联降级
function decodeKittyPrintable(_data: string): string | undefined { return undefined; }
import { KillRing } from "../kill-ring";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import { UndoStack } from "../undo-stack";
import { getSegmenter, isPunctuationChar, isWhitespaceChar, sliceByColumn, visibleWidth } from "../utils";

const segmenter = getSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	private undoStack = new UndoStack<InputState>();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Check if this chunk contains the end marker
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// Extract the pasted content
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				this.handlePaste(pasteContent);

				// Reset paste state
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		// kb 桩 — 原始按键匹配

		// Escape/Cancel
		if (data === "\x1b" || data === "\x03") {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Undo
		if (data === "\x1a") {
			this.undo();
			return;
		}

		// Submit (only on \r — \n is used for newline in multi-line mode)
		if (data === "\r") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// Newline (Shift+Enter or \n in multi-line mode)
		if (data === "\n" || data === "\x1b[13;2u") {
			this.insertCharacter("\n");
			return;
		}

		// Deletion
		if (data === "\x7f" || data === "\b") {
			this.handleBackspace();
			return;
		}

		if (data === "\x1b[3~") {
			this.handleForwardDelete();
			return;
		}

		if (data === "\x17") {
			this.deleteWordBackwards();
			return;
		}

		if (data === "\x1b[3;5~") {
			this.deleteWordForward();
			return;
		}

		if (data === "\x15") {
			this.deleteToLineStart();
			return;
		}

		if (data === "\x0b") {
			this.deleteToLineEnd();
			return;
		}

		// Kill ring actions
		if (data === "\x19") {
			this.yank();
			return;
		}
		if (data === "\x1b[121") {
			this.yankPop();
			return;
		}

		// Cursor movement
		if (data === "\x1b[D") {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (data === "\x1b[C") {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		// Up/Down arrow — multi-line navigation
		if (data === "\x1b[A") {
			this.moveLineUp();
			return;
		}
		if (data === "\x1b[B") {
			this.moveLineDown();
			return;
		}

		if (data === "\x1b[H" || data === "\x01") {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (data === "\x1b[F" || data === "\x05") {
			this.lastAction = null;
			this.cursor = this.value.length;
			return;
		}

		if (data === "\x1b[1;5D") {
			this.moveWordBackwards();
			return;
		}

		if (data === "\x1b[1;5C") {
			this.moveWordForwards();
			return;
		}

		// Kitty CSI-u printable character (e.g. \x1b[97u for 'a').
		// Terminals with Kitty protocol flag 1 (disambiguate) send CSI-u for all keys,
		// including plain printable characters. Decode before the control-char check
		// since CSI-u sequences contain \x1b which would be rejected.
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}

		// Regular character input - accept printable characters including Unicode,
		// but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.insertCharacter(data);
		}
	}

	private insertCharacter(char: string): void {
		// Undo coalescing: consecutive word chars coalesce into one undo unit
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// Save lastAction before cursor movement (moveWordForwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) {
			return;
		}

		this.lastAction = null;
		const textBeforeCursor = this.value.slice(0, this.cursor);
		const graphemes = [...segmenter.segment(textBeforeCursor)];

		// Skip trailing whitespace
		while (graphemes.length > 0 && isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")) {
			this.cursor -= graphemes.pop()?.segment.length || 0;
		}

		if (graphemes.length > 0) {
			const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
			if (isPunctuationChar(lastGrapheme)) {
				// Skip punctuation run
				while (graphemes.length > 0 && isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			} else {
				// Skip word run
				while (
					graphemes.length > 0 &&
					!isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")
				) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			}
		}
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) {
			return;
		}

		this.lastAction = null;
		const textAfterCursor = this.value.slice(this.cursor);
		const segments = segmenter.segment(textAfterCursor);
		const iterator = segments[Symbol.iterator]();
		let next = iterator.next();

		// Skip leading whitespace
		while (!next.done && isWhitespaceChar(next.value.segment)) {
			this.cursor += next.value.segment.length;
			next = iterator.next();
		}

		if (!next.done) {
			const firstGrapheme = next.value.segment;
			if (isPunctuationChar(firstGrapheme)) {
				// Skip punctuation run
				while (!next.done && isPunctuationChar(next.value.segment)) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			} else {
				// Skip word run
				while (!next.done && !isWhitespaceChar(next.value.segment) && !isPunctuationChar(next.value.segment)) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			}
		}
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// Clean the pasted text - remove carriage returns, keep newlines for multi-line, convert tabs
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\t/g, "    ");

		// Insert at cursor position
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	// ── Multi-line navigation ──

	private getLineInfo() {
		const lines = this.value.split("\n");
		let lineIdx = 0;
		let colOffset = this.cursor;
		for (let i = 0; i < lines.length; i++) {
			if (colOffset <= lines[i].length) {
				lineIdx = i;
				break;
			}
			colOffset -= lines[i].length + 1;
			if (i === lines.length - 1) lineIdx = i;
		}
		return { lines, lineIdx, colOffset };
	}

	private moveLineUp(): void {
		this.lastAction = null;
		const { lines, lineIdx, colOffset } = this.getLineInfo();
		if (lineIdx === 0) return;
		const targetLine = lines[lineIdx - 1];
		const targetCol = Math.min(colOffset, targetLine.length);
		// Calculate cursor position: sum of all lines before target line + targetCol
		let pos = 0;
		for (let i = 0; i < lineIdx - 1; i++) {
			pos += lines[i].length + 1;
		}
		pos += targetCol;
		this.cursor = pos;
	}

	private moveLineDown(): void {
		this.lastAction = null;
		const { lines, lineIdx, colOffset } = this.getLineInfo();
		if (lineIdx >= lines.length - 1) return;
		const targetLine = lines[lineIdx + 1];
		const targetCol = Math.min(colOffset, targetLine.length);
		let pos = 0;
		for (let i = 0; i < lineIdx + 1; i++) {
			pos += lines[i].length + 1;
		}
		pos += targetCol;
		this.cursor = pos;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const prompt = "\x1b[1m\x1b[32m❯ \x1b[0m\x1b[32m"; // 绿色 ❯ + 绿色输入文字
		// "❯"(U+276F) 的 eastAsianWidth=2，加空格共 3 个可见列
		const promptVisibleWidth = 3;
		const availableWidth = width - promptVisibleWidth;

		if (availableWidth <= 0) {
			return [prompt];
		}

		// Split value into lines for multi-line support
		const valueLines = this.value.split("\n");
		// Determine which line the cursor is on
		let cursorLineIdx = 0;
		let cursorOffset = this.cursor;
		for (let i = 0; i < valueLines.length; i++) {
			if (cursorOffset <= valueLines[i].length) {
				cursorLineIdx = i;
				break;
			}
			cursorOffset -= valueLines[i].length + 1; // +1 for the \n
			if (i === valueLines.length - 1) {
				cursorLineIdx = i;
			}
		}

		const outputLines: string[] = [];
		for (let lineIdx = 0; lineIdx < valueLines.length; lineIdx++) {
			const lineText = valueLines[lineIdx];
			const isLastLine = lineIdx === valueLines.length - 1;

			// For the last line, we may have a cursor; for others, just render plain
			if (lineIdx === cursorLineIdx) {
				// Line with cursor — use the full cursor rendering logic
				let visibleText = "";
				let cursorDisplay = cursorOffset;
				const totalWidth = visibleWidth(lineText);

				if (totalWidth < availableWidth) {
					visibleText = lineText;
				} else {
					const scrollWidth = cursorOffset === lineText.length ? availableWidth - 1 : availableWidth;
					const cursorCol = visibleWidth(lineText.slice(0, cursorOffset));

					if (scrollWidth > 0) {
						const halfWidth = Math.floor(scrollWidth / 2);
						let startCol = 0;

						if (cursorCol < halfWidth) {
							startCol = 0;
						} else if (cursorCol > totalWidth - halfWidth) {
							startCol = Math.max(0, totalWidth - scrollWidth);
						} else {
							startCol = Math.max(0, cursorCol - halfWidth);
						}

						visibleText = sliceByColumn(lineText, startCol, scrollWidth, true);
						const beforeCursor = sliceByColumn(lineText, startCol, Math.max(0, cursorCol - startCol), true);
						cursorDisplay = beforeCursor.length;
					} else {
						visibleText = "";
						cursorDisplay = 0;
					}
				}

				const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
				const cursorGrapheme = graphemes[0];
				const beforeCursor = visibleText.slice(0, cursorDisplay);
				const atCursor = cursorGrapheme?.segment ?? " ";
				const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
				const marker = this.focused ? CURSOR_MARKER : "";
				const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;
				const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;
				const visualLength = visibleWidth(textWithCursor);
				const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
				outputLines.push(prompt + textWithCursor + padding + "\x1b[0m");
			} else {
				// 非光标行 —— 用 "..."(ASCII三点) 截断，宽度明确为3列
				// 原用 "…"(U+2026)，eastAsianWidth 返回1列，但在中文终端实际渲染为2列，
				// 导致宽度计算与实际渲染不一致，遮挡最后1-2个汉字。
				const totalWidth = visibleWidth(lineText);
				let visibleText: string;
				if (totalWidth <= availableWidth) {
					visibleText = lineText;
				} else {
					const ellipsis = "...";
					const ellipsisWidth = 3;
					visibleText = sliceByColumn(lineText, 0, availableWidth - ellipsisWidth, true) + ellipsis;
				}
				const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(visibleText)));
				const linePrefix = lineIdx === 0 ? prompt : "\x1b[32m  ";
				outputLines.push(linePrefix + visibleText + padding + "\x1b[0m");
			}
		}

		return outputLines;
	}
}
