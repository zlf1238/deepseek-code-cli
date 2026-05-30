/**
 * 消息容器组件（视口裁剪 + 滚动条 + 鼠标交互）。
 *
 * 功能：
 *  - 视口裁剪：只渲染可见范围内的消息行
 *  - 滚动条：右侧显示轨道 + 滑块 + 边界指示
 *  - 鼠标滚轮：在内容区域滚动
 *  - 鼠标拖拽：点击/拖动滚动条跳转位置
 *  - 键盘滚动：PageUp/PageDown/Home/End/Ctrl+↑/Ctrl+↓
 *  - 自动滚动：新消息到达时自动滚到底部；用户手动上滚后暂停，滚到底时恢复
 */
import type { Component } from "../tui/tui";

/** 滚动条宽度（列） */
const SCROLLBAR_WIDTH = 1;

/** 滑块最小高度（行） */
const MIN_THUMB_SIZE = 1;

/** 鼠标滚轮每次滚动行数 */
const WHEEL_SCROLL_LINES = 3;

/** 鼠标事件（从 SGR 序列解析） */
export interface ScrollMouseEvent {
  /** press=按下, release=释放, motion=拖拽中, wheel=滚轮 */
  type: "press" | "release" | "motion" | "wheel";
  /** left, middle, right, none(滚轮) */
  button: "left" | "middle" | "right" | "none";
  /** 列（0-based，屏幕绝对坐标） */
  x: number;
  /** 行（0-based，屏幕绝对坐标） */
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  /** 滚轮方向（仅 wheel 类型有值） */
  wheelDir?: "up" | "down";
}

/**
 * 解析 SGR 鼠标序列 `\x1b[<Cb;Cx;Cy(M|m)`
 * 返回 null 如果不是鼠标序列。
 */
export function parseSGRMouseEvent(data: string): ScrollMouseEvent | null {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!match) return null;

  const cb = parseInt(match[1]!, 10);
  const cx = parseInt(match[2]!, 10) - 1; // 转为 0-based
  const cy = parseInt(match[3]!, 10) - 1;
  const terminator = match[4]!;

  const base = cb & 0x43; // mask out motion (bit 5) and modifier bits
  const motion = (cb & 0x20) !== 0;
  const shift = (cb & 0x04) !== 0;
  const meta = (cb & 0x08) !== 0;
  const ctrl = (cb & 0x10) !== 0;

  // 滚轮事件
  if (cb === 64 || cb === 65) {
    return {
      type: "wheel",
      button: "none",
      x: cx,
      y: cy,
      shift: false,
      meta: false,
      ctrl: false,
      wheelDir: cb === 64 ? "up" : "down",
    };
  }

  let button: "left" | "middle" | "right";
  if (base === 0 || base === 32 || base === 35) button = "left";
  else if (base === 1 || base === 33 || base === 36) button = "middle";
  else if (base === 2 || base === 34 || base === 37) button = "right";
  else button = "left";

  let type: "press" | "release" | "motion";
  if (terminator === "m") {
    type = "release";
  } else if (motion) {
    type = "motion";
  } else {
    type = "press";
  }

  return { type, button, x: cx, y: cy, shift, meta, ctrl };
}

export class PiScrollContainer implements Component {
  private children: Component[] = [];
  private _viewportHeight: number;
  /** 滚动容器在屏幕上的起始行（0-based），由外部设置 */
  public screenRowOffset = 0;

  /** 当前滚动偏移量（第一条可见消息的行索引） */
  scrollOffset = 0;

  /** 是否自动滚动到底部 */
  autoScroll = true;

  /** 上次渲染的总行数（只读） */
  private _lastTotalLines = 0;

  /** 鼠标拖拽状态 */
  private isDragging = false;

  /** 上次渲染时的终端宽度（用于判断点击是否在滚动条上） */
  private _lastRenderWidth = 0;

  get lastTotalLines(): number {
    return this._lastTotalLines;
  }

  /** 滚动条列位置（0-based，屏幕绝对坐标） */
  get scrollbarCol(): number {
    return this._lastRenderWidth - 1;
  }

  constructor(viewportHeight: number) {
    this._viewportHeight = Math.max(1, viewportHeight);
  }

  get viewportHeight(): number {
    return this._viewportHeight;
  }

  set viewportHeight(h: number) {
    this._viewportHeight = Math.max(1, h);
  }

  setChildren(children: Component[]): void {
    this.children = children;
  }

  clear(): void {
    this.children = [];
    this.scrollOffset = 0;
    this._lastTotalLines = 0;
    this.autoScroll = true;
    this.isDragging = false;
  }

  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  /** 强制滚动到底部（新消息到达时调用） */
  scrollToBottom(): void {
    this.autoScroll = true;
    this.scrollOffset = Math.max(0, this.lastTotalLines - this._viewportHeight);
  }

  /**
   * 渲染组件到行数组。
   * 每行 = 内容（width-1 列）+ 滚动条（1 列），不超 width。
   */
  render(width: number): string[] {
    const contentWidth = Math.max(1, width - SCROLLBAR_WIDTH);
    this._lastRenderWidth = width;
    const vh = this._viewportHeight;

    // 1. 渲染全部子组件 → 拿到所有原始行
    const allLines: string[] = [];
    for (const child of this.children) {
      const childLines = child.render(contentWidth);
      for (const line of childLines) {
        allLines.push(line);
      }
    }

    const totalLines = allLines.length;
    this._lastTotalLines = totalLines;

    // 2. 自动滚动逻辑
    if (this.autoScroll) {
      if (totalLines > vh) {
        this.scrollOffset = totalLines - vh;
      } else {
        this.scrollOffset = 0;
      }
    }

    // 3. 边界 Clamp
    if (totalLines > vh) {
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, totalLines - vh));
    } else {
      this.scrollOffset = 0;
    }

    // 4. 检测是否在底部（恢复 autoScroll）
    const atBottom = totalLines <= vh || this.scrollOffset >= totalLines - vh;
    if (atBottom) {
      this.autoScroll = true;
    }

    // 5. 构建可见行 + 滚动条
    const result: string[] = [];
    const hasScrollbar = totalLines > vh;

    for (let i = 0; i < vh; i++) {
      const contentIdx = this.scrollOffset + i;
      let content = "";
      if (contentIdx >= 0 && contentIdx < totalLines) {
        content = allLines[contentIdx];
      }

      // 追加滚动条
      if (hasScrollbar) {
        content += this.renderScrollbarChar(i, vh, totalLines);
      } else {
        content += " ";
      }

      result.push(content);
    }

    return result;
  }

  /**
   * 处理鼠标事件。
   * @param event 解析后的鼠标事件
   * @param termWidth 终端宽度（列数）
   * @returns true 如果事件被消费
   */
  handleMouse(event: ScrollMouseEvent, termWidth: number): boolean {
    const vh = this._viewportHeight;
    const totalLines = this.lastTotalLines;
    const scrollbarCol = termWidth - 1;
    const localRow = event.y - this.screenRowOffset;

    // 检查点击是否在滚动容器视口范围内
    if (localRow < 0 || localRow >= vh) return false;

    // --- 鼠标滚轮 ---
    if (event.type === "wheel") {
      const maxOffset = Math.max(0, totalLines - vh);
      if (event.wheelDir === "up") {
        this.scrollOffset = Math.max(0, this.scrollOffset - WHEEL_SCROLL_LINES);
        this.autoScroll = false;
      } else {
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + WHEEL_SCROLL_LINES);
        if (this.scrollOffset >= maxOffset) {
          this.autoScroll = true;
        }
      }
      return true;
    }

    // --- 点击在滚动条列上 ---
    if (event.x === scrollbarCol && totalLines > vh) {
      if (event.type === "press" && event.button === "left") {
        this.isDragging = true;
        this.scrollToPosition(localRow, vh, totalLines);
        return true;
      }
      if (event.type === "motion" && this.isDragging) {
        this.scrollToPosition(localRow, vh, totalLines);
        return true;
      }
      if (event.type === "release") {
        this.isDragging = false;
        return true;
      }
    }

    // --- 点击在内容区域 ---
    if (event.x < scrollbarCol) {
      if (event.type === "release") {
        this.isDragging = false;
      }
      return false; // 不消费，让事件继续传播
    }

    // 释放时结束拖拽
    if (event.type === "release") {
      this.isDragging = false;
    }

    return false;
  }

  /**
   * 根据鼠标在滚动条上的行位置，计算对应的 scrollOffset。
   */
  private scrollToPosition(mouseRow: number, vh: number, totalLines: number): void {
    const maxOffset = Math.max(0, totalLines - vh);
    if (maxOffset === 0) return;

    // 将鼠标位置映射到 scrollOffset
    const ratio = mouseRow / (vh - 1);
    this.scrollOffset = Math.round(ratio * maxOffset);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));

    // 判断是否到达底部
    if (this.scrollOffset >= maxOffset) {
      this.autoScroll = true;
    } else {
      this.autoScroll = false;
    }
  }

  /**
   * 渲染滚动条的一个字符。
   * 轨道使用细竖线 │，滑块使用实心块 █。
   */
  private renderScrollbarChar(lineIdx: number, vh: number, totalLines: number): string {
    const trackHeight = vh;
    const maxScroll = Math.max(1, totalLines - vh);

    // 滑块高度：与视口/总行数比例一致，最少 1 行
    const thumbSize = Math.max(MIN_THUMB_SIZE, Math.floor((vh * vh) / totalLines));

    // 滑块顶部在轨道中的位置
    const maxThumbTop = Math.max(0, trackHeight - thumbSize);
    const thumbTop = Math.min(
      maxThumbTop,
      Math.floor((this.scrollOffset * maxThumbTop) / maxScroll),
    );
    const thumbBottom = thumbTop + thumbSize;

    if (lineIdx >= thumbTop && lineIdx < thumbBottom) {
      return "\x1b[37m█\x1b[0m"; // 白色滑块
    }

    return "\x1b[90m│\x1b[0m"; // 灰色轨道
  }

  /**
   * 处理键盘滚动输入。
   */
  handleInput(data: string): void {
    const vh = Math.max(1, this._viewportHeight);
    const totalLines = this.lastTotalLines;
    const maxOffset = Math.max(0, totalLines - vh);

    switch (data) {
      case "\x1b[5~": // PageUp
        this.scrollOffset = Math.max(0, this.scrollOffset - vh);
        this.autoScroll = false;
        return;

      case "\x1b[6~": // PageDown
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + vh);
        if (this.scrollOffset >= maxOffset) {
          this.autoScroll = true;
        }
        return;

      case "\x1b[H": // Home
      case "\x1b[1~": // Home (alternative)
      case "\x1bOH": // Home (application mode)
        this.scrollOffset = 0;
        this.autoScroll = false;
        return;

      case "\x1b[F": // End
      case "\x1b[4~": // End (alternative)
      case "\x1bOF": // End (application mode)
        this.scrollToBottom();
        return;

      case "\x1b[1;5A": // Ctrl+Up
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        this.autoScroll = false;
        return;

      case "\x1b[1;5B": // Ctrl+Down
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
        if (this.scrollOffset >= maxOffset) {
          this.autoScroll = true;
        }
        return;
    }
  }
}
