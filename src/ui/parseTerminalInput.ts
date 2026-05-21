/** 终端输入解析：将原始字节序列解析为按键事件 */

// ---------------------------------------------------------------------------
// 按键常量集合
// ---------------------------------------------------------------------------

const BACKSPACE_BYTES = new Set(["", "\b"]);
const FORWARD_DELETE_SEQUENCES = new Set(["\u001b[3~", "\u001b[P"]);
const HOME_SEQUENCES = new Set(["\u001b[H", "\u001b[1~", "\u001b[7~", "\u001bOH"]);
const END_SEQUENCES = new Set(["\u001b[F", "\u001b[4~", "\u001b[8~", "\u001bOF"]);
const SHIFT_RETURN_SEQUENCES = new Set(["\u001b\r", "\u001b[13;2u"]);
const META_RETURN_SEQUENCES = new Set(["\u001b[13;3u", "\u001b[13;4u"]);
const CTRL_LEFT_SEQUENCES = new Set(["\u001b[1;5D", "\u001b[5D"]);
const CTRL_RIGHT_SEQUENCES = new Set(["\u001b[1;5C", "\u001b[5C"]);
const META_LEFT_SEQUENCES = new Set(["\u001b[1;3D", "\u001b[3D", "\u001bb"]);
const META_RIGHT_SEQUENCES = new Set(["\u001b[1;3C", "\u001b[3C", "\u001bf"]);
const TERMINAL_FOCUS_IN = "\u001b[I";
const TERMINAL_FOCUS_OUT = "\u001b[O";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type InputKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  home: boolean;
  end: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  focusIn: boolean;
  focusOut: boolean;
};

export const NO_MODIFIERS: InputKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  home: false, end: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false,
  tab: false, backspace: false, delete: false, meta: false,
  focusIn: false, focusOut: false,
};

// ---------------------------------------------------------------------------
// 解析函数
// ---------------------------------------------------------------------------

/**
 * 将终端原始输入解析为字符和按键修饰信息。
 * 支持：箭头键、Home/End、PageUp/Down、Ctrl组合、
 * Shift+Enter、Meta组合、退格/删除、Tab、焦点事件等。
 */
export function parseTerminalInput(data: Buffer | string): { input: string; key: InputKey } {
  const raw = String(data);
  let input = raw;
  const key: InputKey = {
    upArrow: raw === "\u001B[A",
    downArrow: raw === "\u001B[B",
    leftArrow: raw === "\u001B[D" || CTRL_LEFT_SEQUENCES.has(raw) || META_LEFT_SEQUENCES.has(raw),
    rightArrow: raw === "\u001B[C" || CTRL_RIGHT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw),
    home: HOME_SEQUENCES.has(raw),
    end: END_SEQUENCES.has(raw),
    pageDown: raw === "\u001B[6~",
    pageUp: raw === "\u001B[5~",
    return: raw === "\r" || SHIFT_RETURN_SEQUENCES.has(raw) || META_RETURN_SEQUENCES.has(raw),
    escape: raw === "\u001B",
    ctrl: CTRL_LEFT_SEQUENCES.has(raw) || CTRL_RIGHT_SEQUENCES.has(raw),
    shift: SHIFT_RETURN_SEQUENCES.has(raw),
    tab: raw === "\t" || raw === "\u001B[Z",
    backspace: BACKSPACE_BYTES.has(raw),
    delete: FORWARD_DELETE_SEQUENCES.has(raw),
    meta: META_LEFT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw) || META_RETURN_SEQUENCES.has(raw),
    focusIn: raw === TERMINAL_FOCUS_IN,
    focusOut: raw === TERMINAL_FOCUS_OUT,
  };

  // Ctrl + 字母：将 0x01-0x1A 转换为 a-z
  if (input <= "\u001A" && !key.return) {
    input = String.fromCharCode(input.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  }

  const isKnownEscapeSequence =
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
    key.home || key.end || key.pageDown || key.pageUp ||
    key.tab || key.delete || key.return || key.ctrl ||
    key.meta || key.focusIn || key.focusOut;

  // Escape 前缀的未知序列视为 meta 组合
  if (raw.startsWith("\u001B")) {
    input = raw.slice(1);
    key.meta = key.meta || !isKnownEscapeSequence;
  }

  // 大写字母标记 shift
  const isLatinUppercase = input >= "A" && input <= "Z";
  const isCyrillicUppercase = input >= "А" && input <= "Я";
  if (input.length === 1 && (isLatinUppercase || isCyrillicUppercase)) {
    key.shift = true;
  }

  if (key.tab && input === "[Z") {
    key.shift = true;
  }

  // 控制键不产生文本输入
  if (key.tab || key.backspace || key.delete) {
    input = "";
  }

  return { input, key };
}
