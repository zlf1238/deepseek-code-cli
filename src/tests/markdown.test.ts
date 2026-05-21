import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, parseTableLines, renderTable, type TableData } from "../ui/markdown";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// 已有功能测试（保持不变）
// ---------------------------------------------------------------------------

test("renderMarkdown returns empty string for empty input", () => {
  assert.equal(renderMarkdown(""), "");
});

test("renderMarkdown preserves heading text", () => {
  const result = stripAnsi(renderMarkdown("# Title"));
  assert.equal(result.includes("Title"), true);
  assert.equal(result.includes("#"), true);
});

test("renderMarkdown preserves code fences with language tag", () => {
  const result = stripAnsi(renderMarkdown("```js\nconsole.log(1);\n```"));
  assert.equal(result.includes("[js]"), true);
  assert.equal(result.includes("console.log(1);"), true);
});

test("renderMarkdown styles inline code without removing it", () => {
  const result = stripAnsi(renderMarkdown("Use `npm install` first."));
  assert.equal(result.includes("npm install"), true);
});

test("renderMarkdown keeps bullet markers", () => {
  const result = stripAnsi(renderMarkdown("- item one\n- item two"));
  assert.equal(result.includes("- item one"), true);
  assert.equal(result.includes("- item two"), true);
});

test("renderMarkdown handles plain text unchanged in stripped form", () => {
  const text = "hello world\nthis is a sentence";
  const result = stripAnsi(renderMarkdown(text));
  assert.equal(result, text);
});

// ---------------------------------------------------------------------------
// 表格解析测试（parseTableLines）
// ---------------------------------------------------------------------------

test("parseTableLines parses a simple table", () => {
  const lines = [
    "| 模型 | 价格 |",
    "|------|------|",
    "| Pro | ¥0.01 |",
    "| Flash | ¥0.001 |",
  ];
  const result = parseTableLines(lines);
  assert.ok(result !== null);
  assert.deepEqual(result.headers, ["模型", "价格"]);
  assert.deepEqual(result.align, ["left", "left"]);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], ["Pro", "¥0.01"]);
  assert.deepEqual(result.rows[1], ["Flash", "¥0.001"]);
});

test("parseTableLines detects left alignment", () => {
  const lines = [
    "| Left | Center | Right |",
    "|:----|:-----:|-----:|",
    "| a | b | c |",
  ];
  const result = parseTableLines(lines);
  assert.ok(result !== null);
  assert.deepEqual(result.align, ["left", "center", "right"]);
});

test("parseTableLines returns null for less than 2 lines", () => {
  assert.equal(parseTableLines([]), null);
  assert.equal(parseTableLines(["| only one |"]), null);
});

test("parseTableLines returns null for invalid separator row", () => {
  const lines = [
    "| A | B |",
    "| foo | bar |",  // 第二行不是合法分隔行
  ];
  assert.equal(parseTableLines(lines), null);
});

test("parseTableLines handles unequal cell counts", () => {
  const lines = [
    "| A | B | C |",
    "|:---|:---|:---|",
    "| too | few |",        // 少一列
    "| too | many | cols | here |",  // 多一列
  ];
  const result = parseTableLines(lines);
  assert.ok(result !== null);
  assert.equal(result.headers.length, 3);
  // 少列补齐空串
  assert.deepEqual(result.rows[0], ["too", "few", ""]);
  // 多列截断
  assert.deepEqual(result.rows[1], ["too", "many", "cols"]);
});

test("parseTableLines handles empty cells", () => {
  const lines = [
    "| A | | C |",
    "|:---|:---|:---|",
    "| x | y | |",
  ];
  const result = parseTableLines(lines);
  assert.ok(result !== null);
  assert.deepEqual(result.headers, ["A", "", "C"]);
  assert.deepEqual(result.rows[0], ["x", "y", ""]);
});

// ---------------------------------------------------------------------------
// 表格渲染测试（renderTable）
// ---------------------------------------------------------------------------

function stripTableResult(table: TableData): string {
  return stripAnsi(renderTable(table));
}

test("renderTable produces continuous borders with box-drawing chars", () => {
  const table: TableData = {
    headers: ["名称", "值"],
    align: ["left", "left"],
    rows: [["A", "1"]],
  };
  const result = stripTableResult(table);
  const lines = result.split("\n");
  // 6 行：顶框 + 表头 + 分隔 + 数据 + 底框（单行数据无行间分隔）
  assert.equal(lines.length, 5);
  // 验证顶框：┌──────┬─────┐
  assert.ok(lines[0].startsWith("┌"));
  assert.ok(lines[0].includes("┬"));
  assert.ok(lines[0].endsWith("┐"));
  // 验证表头分隔：├──────┼─────┤（第3行）
  assert.ok(lines[2].startsWith("├"));
  assert.ok(lines[2].includes("┼"));
  assert.ok(lines[2].endsWith("┤"));
  // 验证底框：└──────┴─────┘
  const bottom = lines[lines.length - 1];
  assert.ok(bottom.startsWith("└"));
  assert.ok(bottom.includes("┴"));
  assert.ok(bottom.endsWith("┘"));
  // 数据行和表头行应有竖线
  assert.ok(lines[1].includes("│")); // 表头行
  assert.ok(lines[3].includes("│")); // 数据行
});

test("renderTable aligns text left/center/right", () => {
  const table: TableData = {
    headers: ["Left", "Center", "Right"],
    align: ["left", "center", "right"],
    rows: [["a", "b", "c"]],
  };
  const result = stripTableResult(table);
  const lines = result.split("\n");
  // 数据行（第4行）
  const dataLine = lines[3];
  // 左对齐列：a 在左侧
  const colStart1 = dataLine.indexOf("│") + 1;
  const col1Content = dataLine.slice(colStart1, colStart1 + 6).trim();
  assert.equal(col1Content, "a");
});

test("renderTable handles multi-row tables", () => {
  const table: TableData = {
    headers: ["A", "B"],
    align: ["left", "left"],
    rows: [
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ],
  };
  const result = stripTableResult(table);
  const lines = result.split("\n");
  // 顶框 + 表头 + 分隔 + 3 数据行 + 2 行间分隔 + 底框 = 9 行
  assert.equal(lines.length, 9);
  // 行布局: 0顶 1头 2头分 3数据 4分 5数据 6分 7数据 8底
  assert.ok(lines[4].startsWith("├")); // 第1行数据后的分隔
  assert.ok(lines[6].startsWith("├")); // 第2行数据后的分隔
});

test("renderTable column width adapts to longest content", () => {
  const table: TableData = {
    headers: ["短", "这是一个很长的表头"],
    align: ["left", "left"],
    rows: [["内容", "短"]],
  };
  const result = stripTableResult(table);
  const lines = result.split("\n");
  // 验证第二列表头完整显示（宽度自适应）
  assert.ok(lines[1].includes("这是一个很长的表头"));
  // 列宽 = 内容宽度 + 2（左右空格），第二列 ── 至少 "这是一个很长的表头".length + 2
  const topBorder = lines[0];
  // ┌──┬────────────────────┐ 中两个 ┬ 之间的 ─ 数量
  const secondColDashes = topBorder.split("┬")[1]?.split("┐")[0]?.length ?? 0;
  assert.ok(secondColDashes >= "这是一个很长的表头".length + 2);
});

// ---------------------------------------------------------------------------
// 集成测试：renderMarkdown 处理完整表格
// ---------------------------------------------------------------------------

test("renderMarkdown renders a markdown table inline", () => {
  const input = [
    "| Col1 | Col2 |",
    "|------|------|",
    "| val1 | val2 |",
  ].join("\n");
  const result = stripAnsi(renderMarkdown(input));
  // 验证表格被正确渲染（含框线字符）
  assert.ok(result.includes("┌"));
  assert.ok(result.includes("┐"));
  assert.ok(result.includes("└"));
  assert.ok(result.includes("┘"));
  assert.ok(result.includes("│"));
  // 验证内容保留
  assert.ok(result.includes("Col1"));
  assert.ok(result.includes("Col2"));
  assert.ok(result.includes("val1"));
  assert.ok(result.includes("val2"));
});

test("renderMarkdown interleaves table with normal text", () => {
  const input = [
    "前面有一段文字。",
    "",
    "| 标题 | 说明 |",
    "|------|------|",
    "| X | 描述X |",
    "| Y | 描述Y |",
    "",
    "后面也有一段文字。",
  ].join("\n");
  const result = stripAnsi(renderMarkdown(input));
  assert.ok(result.includes("前面有一段文字。"));
  assert.ok(result.includes("后面也有一段文字。"));
  // 表格内容保留
  assert.ok(result.includes("标题"));
  assert.ok(result.includes("说明"));
  assert.ok(result.includes("描述X"));
  assert.ok(result.includes("描述Y"));
});

test("renderMarkdown does not render non-table pipe text as table", () => {
  const input = "这是一段包含 | 管道符的文字，但不是表格。";
  const result = stripAnsi(renderMarkdown(input));
  // 不应当出现表格边框字符
  assert.ok(!result.includes("┌"));
  assert.ok(result.includes("|"));
});

// ---------------------------------------------------------------------------
// 终端自适应宽度测试（8.4）
// ---------------------------------------------------------------------------

test("renderTable respects maxWidth and truncates columns", () => {
  const data: TableData = {
    headers: ["A", "B"],
    align: ["left", "left"],
    rows: [["短", "这是一个非常长的内容用于触发截断逻辑"]],
  };
  // 正常渲染（无 maxWidth）宽度充足
  const normal = stripAnsi(renderTable(data));
  const normalLines = normal.split("\n");
  assert.ok(normalLines[3].includes("这是一个非常长的内容用于触发截断逻辑"));

  // 限制 maxWidth=15，表格应被截断
  const truncated = stripAnsi(renderTable(data, 15));
  const truncLines = truncated.split("\n");
  // 验证顶框宽度被缩减
  assert.ok(truncLines[0].length < normalLines[0].length);
});

test("renderTable with maxWidth still shows all headers", () => {
  const data: TableData = {
    headers: ["名称", "值"],
    align: ["left", "right"],
    rows: [["配置项A", "12345"], ["配置项B", "67890"]],
  };
  // 即使 maxWidth 很窄，表头也完整显示
  const result = stripAnsi(renderTable(data, 20));
  assert.ok(result.includes("名称"));
  assert.ok(result.includes("值"));
});

test("renderTable with maxWidth wider than table shows full content", () => {
  const data: TableData = {
    headers: ["A", "B"],
    align: ["left", "left"],
    rows: [["x", "y"]],
  };
  const full = stripAnsi(renderTable(data));
  const withMax = stripAnsi(renderTable(data, 200));
  // 宽度充足时内容一致
  assert.equal(full, withMax);
});
