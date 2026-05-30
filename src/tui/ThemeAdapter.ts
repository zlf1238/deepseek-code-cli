/** pi TUI 样式适配器：将本项目的 chalk 样式包装为 pi 的 (text: string) => string 格式 */
import chalk from "chalk";

/** pi 颜色函数格式：接收纯文本，返回带 ANSI 转义码的文本 */
export type ColorFn = (text: string) => string;

export const Theme = {
  /** 状态栏背景色 */
  barBg: ((text: string) => chalk.bgBlue.white(text)) as ColorFn,

  /** 选中的条目 */
  selectedPrefix: ((text: string) => chalk.green.bold(text)) as ColorFn,
  selectedText: ((text: string) => chalk.white.bold(text)) as ColorFn,

  /** 描述/辅助文本 */
  description: ((text: string) => chalk.dim(text)) as ColorFn,
  dimText: ((text: string) => chalk.dim(text)) as ColorFn,

  /** 强调/标题 */
  boldText: ((text: string) => chalk.bold(text)) as ColorFn,
  cyanText: ((text: string) => chalk.cyan(text)) as ColorFn,

  /** 用户消息（绿色加粗区分） */
  userText: ((text: string) => chalk.green.bold(text)) as ColorFn,

  /** 错误/警告 */
  errorText: ((text: string) => chalk.red(text)) as ColorFn,
  warnText: ((text: string) => chalk.yellow(text)) as ColorFn,

  /** 状态栏（黄色区分） */
  statusText: ((text: string) => chalk.yellow(text)) as ColorFn,

  /** 模型标签 */
  modelTag: ((text: string) => chalk.magenta(text)) as ColorFn,
} as const;
