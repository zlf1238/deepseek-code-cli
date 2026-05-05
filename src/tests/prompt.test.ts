import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemPrompt, getTools } from "../prompt";

test("getTools always includes WebSearch for default (pro) model", () => {
  const names = getTools().map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
  assert.equal(names.includes("bash"), true);
  assert.equal(names.includes("AskUserQuestion"), true);
});

test("getTools with flash model returns only file operation tools", () => {
  const names = getTools({ model: "deepseek-v4-flash" }).map((tool) => tool.function.name);
  assert.equal(names.includes("read"), true);
  assert.equal(names.includes("write"), true);
  assert.equal(names.includes("edit"), true);
  assert.equal(names.includes("glob"), true);
  assert.equal(names.includes("grep"), true);
  // Flash should NOT have these
  assert.equal(names.includes("bash"), false);
  assert.equal(names.includes("AskUserQuestion"), false);
  assert.equal(names.includes("WebSearch"), false);
  // Exactly 5 file operation tools
  assert.equal(names.length, 5);
});

test("getSystemPrompt always includes WebSearch docs for default (pro) model", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## WebSearch"), true);
  assert.equal(prompt.includes("## Bash"), true);
});

test("getSystemPrompt with flash model excludes non-file tool docs", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-flash" });
  // Flash docs should only include file operation tools
  assert.equal(prompt.includes("## Read"), true);
  assert.equal(prompt.includes("## Write"), true);
  assert.equal(prompt.includes("## Edit"), true);
  assert.equal(prompt.includes("## Glob"), true);
  assert.equal(prompt.includes("## Grep"), true);
  // Flash docs should NOT include these
  assert.equal(prompt.includes("## WebSearch"), false);
  assert.equal(prompt.includes("## Bash"), false);
  assert.equal(prompt.includes("## AskUserQuestion"), false);
});

test("getSystemPrompt with flash model uses flash-specific system prompt", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-flash" });
  assert.equal(prompt.includes("专注于文件操作"), true);
  assert.equal(prompt.includes("直接执行，做完即止"), true);
});

test("getSystemPrompt with pro model uses full system prompt", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-pro" });
  assert.equal(prompt.includes("交互式 CLI 工具"), true);
  assert.equal(prompt.includes("## WebSearch"), true);
  assert.equal(prompt.includes("## Bash"), true);
});
