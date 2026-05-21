import chalk from "chalk";

/** 表格列对齐方式 */
export type TableAlign = "left" | "center" | "right";

/** 解析后的表格数据结构 */
export type TableData = {
  headers: string[];
  align: TableAlign[];
  rows: string[][];
};

export function renderMarkdown(text: string): string {
  if (!text) {
    return "";
  }

  const fenceSegments = splitByFences(text);
  return fenceSegments
    .map((segment) => {
      if (segment.kind === "code") {
        const langTag = segment.lang ? chalk.dim(`[${segment.lang}]`) + "\n" : "";
        return langTag + chalk.cyan(segment.body);
      }
      return renderTextBlock(segment.body);
    })
    .join("");
}

type FenceSegment =
  | { kind: "text"; body: string }
  | { kind: "code"; lang: string; body: string };

function splitByFences(text: string): FenceSegment[] {
  const segments: FenceSegment[] = [];
  const lines = text.split(/\r?\n/);
  let buffer: string[] = [];
  let inFence = false;
  let fenceLang = "";
  let fenceBody: string[] = [];

  const flushText = () => {
    if (buffer.length === 0) {
      return;
    }
    segments.push({ kind: "text", body: buffer.join("\n") });
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = /^\s*```(\w*)\s*$/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        flushText();
        inFence = true;
        fenceLang = fenceMatch[1] ?? "";
        fenceBody = [];
      } else {
        segments.push({ kind: "code", lang: fenceLang, body: fenceBody.join("\n") });
        inFence = false;
        fenceLang = "";
        fenceBody = [];
      }
      continue;
    }

    if (inFence) {
      fenceBody.push(line);
    } else {
      buffer.push(line);
    }
  }

  if (inFence) {
    segments.push({ kind: "code", lang: fenceLang, body: fenceBody.join("\n") });
  } else {
    flushText();
  }

  return segments;
}

/**
 * 渲染文本块（非代码段），自动识别并渲染 Markdown 表格。
 * 连续以 | 开头的行视为表格，其余行按原 inline 逻辑渲染。
 */
function renderTextBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let tableBuffer: string[] = [];
  let i = 0;

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const rendered = renderTableFromLines(tableBuffer);
    if (rendered) {
      result.push(rendered);
    } else {
      // 表格解析失败，回退为普通行
      for (const line of tableBuffer) {
        result.push(renderInlineLine(line));
      }
    }
    tableBuffer = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 检测表格行：以 | 开头或上一行正在积累表格
    if (trimmed.startsWith("|") && isTableRow(trimmed)) {
      tableBuffer.push(line);
    } else {
      flushTable();
      result.push(renderInlineLine(line));
    }
    i++;
  }
  flushTable();

  return result.join("\n");
}

/** 判断一行是否是合法的表格行（至少有一个 | 且内容不包含代码标记） */
function isTableRow(line: string): boolean {
  // 排除 fences（已在 splitByFences 处理），只判断 | 结构
  const cells = line.split("|").filter((c) => c.trim().length > 0);
  return cells.length >= 2;
}

// ---------------------------------------------------------------------------
// 表格解析
// ---------------------------------------------------------------------------

/** 从连续表格行中解析表格数据 */
export function parseTableLines(lines: string[]): TableData | null {
  if (lines.length < 2) return null;

  const headerCells = parseRow(lines[0]);
  if (!headerCells || headerCells.length === 0) return null;

  const alignInfo = parseAlignRow(lines[1]);
  if (!alignInfo) return null;

  const numCols = headerCells.length;
  const align = alignInfo.length === numCols ? alignInfo : Array(numCols).fill("left") as TableAlign[];

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = parseRow(lines[i]);
    if (cells) {
      // 补齐或截断到列数
      const padded = cells.slice(0, numCols);
      while (padded.length < numCols) padded.push("");
      rows.push(padded);
    }
  }

  return { headers: headerCells, align, rows };
}

/** 解析单行表格单元格 */
function parseRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  // 去掉首尾的 |
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/** 解析对齐行（第二行），返回每列对齐方式 */
function parseAlignRow(line: string): TableAlign[] | null {
  const cells = parseRow(line);
  if (!cells || cells.length === 0) return null;

  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const trimmed = cell.trim();
    // 分隔行应仅包含 - 和 :，否则不是合法的对齐行
    if (!/^:?-+:?$/.test(trimmed)) return null;
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// 表格渲染
// ---------------------------------------------------------------------------

/** 带终端颜色的表格渲染结果 */
export type RenderedTable = {
  /** 纯文本（去色后）宽度，用于判断是否超屏 */
  width: number;
  /** 渲染后的字符串（含 ANSI 颜色） */
  text: string;
};

/** Unicode 制表符 */
const TC = {
  TL: "┌", TR: "┐", BL: "└", BR: "┘",
  H: "─", V: "│",
  TH: "┬", BH: "┴", LH: "├", RH: "┤",
  CROSS: "┼",
};

/**
 * 将表格行列表渲染为带连续边框线的表格字符串。
 * 外部调用（非测试）可直接使用此函数，测试中可分别测试 parseTableLines 和 renderTable。
 */
export function renderTableFromLines(lines: string[]): string | null {
  const table = parseTableLines(lines);
  if (!table) return null;
  return renderTable(table);
}

/**
 * 将解析后的表格数据渲染为带 Unicode 制表符边框的字符串。
 * 支持左/中/右对齐，每列宽度按最长内容自适应。
 */
export function renderTable(data: TableData, maxWidth?: number): string {
  const { headers, align, rows } = data;
  const numCols = headers.length;

  // 计算每列宽度：取表头和数据中最长的内容 + 左右各 1 空格
  let colWidths = headers.map((header, colIdx) => {
    let max = header.length;
    for (const row of rows) {
      if (row[colIdx] && row[colIdx].length > max) {
        max = row[colIdx].length;
      }
    }
    return Math.max(max, 1);
  });

  // 8.4 终端自适应宽度：总宽度超过 maxWidth 时，按比例截断
  if (maxWidth && maxWidth > 0) {
    const borderChars = numCols + 1;
    const paddingChars = numCols * 2;
    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + borderChars + paddingChars;

    if (totalWidth > maxWidth) {
      const overflow = totalWidth - maxWidth;
      const totalColWidth = colWidths.reduce((a, b) => a + b, 0);
      if (totalColWidth > 0) {
        colWidths = colWidths.map((w, idx) => {
          const headerLen = headers[idx].length;
          if (w <= headerLen) return w;
          const minWidth = Math.max(headerLen, 3);
          const shrink = Math.round((w / totalColWidth) * overflow);
          return Math.max(minWidth, w - shrink);
        });
      }
    }
  }

  // 构建水平分隔线（复用列宽）
  const topBorder = buildBorderLine(colWidths, TC.TL, TC.TH, TC.TR);
  const headerSep = buildBorderLine(colWidths, TC.LH, TC.CROSS, TC.RH);
  const bottomBorder = buildBorderLine(colWidths, TC.BL, TC.BH, TC.BR);

  // 行分隔线（数据行之间）
  const rowSep = buildBorderLine(colWidths, TC.LH, TC.CROSS, TC.RH);

  // 表头行
  const headerLine = buildDataLine(colWidths, headers, align);

  // 数据行
  const dataLines = rows.map((row) => buildDataLine(colWidths, row, align));

  // 组装：顶框 + 表头 + 分隔 + 数据行（行间加分隔线）+ 底框
  const lines: string[] = [topBorder, headerLine, headerSep];
  for (let i = 0; i < dataLines.length; i++) {
    lines.push(dataLines[i]);
    if (i < dataLines.length - 1) {
      lines.push(rowSep);
    }
  }
  lines.push(bottomBorder);

  // 边框线和分隔线使用 dim 灰色，表头加粗，内容保持原样
  const dimBorder = (s: string) => chalk.dim(s);
  const boldHeader = (s: string) => chalk.bold(s);

  return lines
    .map((line, idx) => {
      if (idx === 0 || idx === 2 || idx === lines.length - 1) {
        // 顶框 / 表头分隔 / 底框 → 全 dim
        return dimBorder(line);
      }
      if (idx === 1) {
        // 表头行 → 边框 dim + 内容 bold
        return dimBorderBorderLine(line, boldHeader);
      }
      // 数据行 → 边框 dim + 内容正常
      return dimBorderBorderLine(line);
    })
    .join("\n");
}

/** 构建水平边框线：┌──┬──┐ / ├──┼──┤ / └──┴──┘ */
function buildBorderLine(
  colWidths: number[],
  left: string,
  joint: string,
  right: string,
): string {
  const segments = colWidths.map((w) => TC.H.repeat(w + 2)); // +2 对应左右空格
  return left + segments.join(joint) + right;
}

/** 构建数据行：│ 内容 │ 内容 │ */
function buildDataLine(
  colWidths: number[],
  cells: string[],
  align: TableAlign[],
): string {
  const parts = cells.map((cell, idx) => {
    const width = colWidths[idx];
    const text = idx < cells.length ? cell : "";
    const padded = padCell(text, width, align[idx] ?? "left");
    return ` ${padded} `;
  });
  return TC.V + parts.join(TC.V) + TC.V;
}

/** 按对齐方式填充单元格到指定宽度 */
function padCell(text: string, width: number, align: TableAlign): string {
  const len = text.length;
  if (len >= width) return text;

  const diff = width - len;
  switch (align) {
    case "left":
      return text + " ".repeat(diff);
    case "right":
      return " ".repeat(diff) + text;
    case "center": {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return " ".repeat(left) + text + " ".repeat(right);
    }
  }
}

/** 将一行中的边框字符（│）设为 dim，其余部分保持原样式函数 */
function dimBorderBorderLine(line: string, styleContent?: (s: string) => string): string {
  // line 格式: "│ 内容 │ 内容 │"
  // 将每个 │ 单独 dim
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === TC.V) {
      result += chalk.dim(TC.V);
      i++;
    } else {
      // 收集到下一个 │ 或结尾
      const start = i;
      while (i < line.length && line[i] !== TC.V) i++;
      let segment = line.slice(start, i);
      if (styleContent) {
        segment = styleContent(segment);
      }
      result += segment;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 原有 inline 渲染（不变）
// ---------------------------------------------------------------------------

function renderInlineLine(line: string): string {
  const headingMatch = /^(\s*)(#{1,6})\s+(.*)$/.exec(line);
  if (headingMatch) {
    const [, lead, hashes, content] = headingMatch;
    const styled = hashes.length <= 2 ? chalk.bold.cyanBright(content) : chalk.bold.cyan(content);
    return `${lead}${chalk.dim(hashes)} ${styled}`;
  }

  const listMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (listMatch) {
    const [, lead, bullet, content] = listMatch;
    return `${lead}${chalk.yellow(bullet)} ${renderInlineSpans(content)}`;
  }

  const numListMatch = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
  if (numListMatch) {
    const [, lead, marker, content] = numListMatch;
    return `${lead}${chalk.yellow(marker)} ${renderInlineSpans(content)}`;
  }

  const quoteMatch = /^(\s*)>\s?(.*)$/.exec(line);
  if (quoteMatch) {
    const [, lead, content] = quoteMatch;
    return `${lead}${chalk.dim("│ ")}${chalk.italic(renderInlineSpans(content))}`;
  }

  return renderInlineSpans(line);
}

function renderInlineSpans(text: string): string {
  if (!text) {
    return text;
  }
  let result = text;
  result = result.replace(/`([^`]+)`/g, (_, inner) => chalk.cyan(inner));
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, inner) => chalk.bold(inner));
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, inner) => chalk.italic(inner));
  result = result.replace(/_([^_\n]+)_/g, (_, inner) => chalk.italic(inner));
  return result;
}
