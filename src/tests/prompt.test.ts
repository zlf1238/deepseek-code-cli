import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemPrompt, getTools, getFlashAutoSwitchMessage } from "../prompt";

test("getTools always includes all 8 tools for default (pro) model", () => {
  const names = getTools().map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
  assert.equal(names.includes("bash"), true);
  assert.equal(names.includes("AskUserQuestion"), true);
  assert.equal(names.length, 8);
});

test("getTools with flash model but no flashAutoSwitch (primary flash) returns all 8 tools", () => {
  const names = getTools({ model: "deepseek-v4-flash" }).map((tool) => tool.function.name);
  assert.equal(names.includes("WebSearch"), true);
  assert.equal(names.includes("bash"), true);
  assert.equal(names.includes("read"), true);
  assert.equal(names.length, 8);
});

test("getTools with flash model and flashAutoSwitch returns file + bash tools", () => {
  const names = getTools({ model: "deepseek-v4-flash", flashAutoSwitch: true }).map((tool) => tool.function.name);
  assert.equal(names.includes("read"), true);
  assert.equal(names.includes("write"), true);
  assert.equal(names.includes("edit"), true);
  assert.equal(names.includes("glob"), true);
  assert.equal(names.includes("grep"), true);
  assert.equal(names.includes("bash"), true);
  // Auto-switch flash should NOT have these
  assert.equal(names.includes("AskUserQuestion"), false);
  assert.equal(names.includes("WebSearch"), false);
  // Exactly 6 tools (file ops + bash)
  assert.equal(names.length, 6);
});

test("getSystemPrompt without model returns full prompt with all tool docs", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("## WebSearch"), true);
  assert.equal(prompt.includes("## Bash"), true);
  assert.equal(prompt.includes("交互式 CLI 工具"), true);
});

test("getSystemPrompt with flash model but no flashAutoSwitch (primary flash) returns full prompt", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-flash" });
  // Primary flash still gets full system prompt and all tool docs
  assert.equal(prompt.includes("交互式 CLI 工具"), true);
  assert.equal(prompt.includes("## WebSearch"), true);
  assert.equal(prompt.includes("## Bash"), true);
});

test("getSystemPrompt with flash model and flashAutoSwitch uses flash-specific prompt and limited docs", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-flash", flashAutoSwitch: true });
  // Flash-specific system prompt
  assert.equal(prompt.includes("快速执行用户请求"), true);
  assert.equal(prompt.includes("直接执行，做完即止"), true);
  // File operation docs + bash included
  assert.equal(prompt.includes("## Read"), true);
  assert.equal(prompt.includes("## Grep"), true);
  assert.equal(prompt.includes("## Bash"), true);
  // Non-file/non-bash docs excluded
  assert.equal(prompt.includes("## WebSearch"), false);
  assert.equal(prompt.includes("## AskUserQuestion"), false);
});

test("getSystemPrompt with pro model returns full system prompt", () => {
  const prompt = getSystemPrompt("/tmp/project", { model: "deepseek-v4-pro" });
  assert.equal(prompt.includes("交互式 CLI 工具"), true);
  assert.equal(prompt.includes("## WebSearch"), true);
  assert.equal(prompt.includes("## Bash"), true);
});

test("getFlashAutoSwitchMessage returns the auto-switch adaptation message", () => {
  const msg = getFlashAutoSwitchMessage();
  assert.equal(msg.includes("deepseek-v4-flash"), true);
  assert.equal(msg.includes("read"), true);
  assert.equal(msg.includes("快速模式"), true);
  assert.equal(msg.includes("不启用深度思考"), true);
});
