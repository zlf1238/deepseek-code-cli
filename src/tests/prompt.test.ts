import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemPrompt, getTools, getFlashAutoSwitchMessage } from "../prompt";

test("getTools always includes all tools regardless of model", () => {
  // 默认（无参数）
  const defaultNames = getTools().map((tool) => tool.function.name);
  assert.equal(defaultNames.includes("WebSearch"), true);
  assert.equal(defaultNames.includes("bash"), true);
  assert.equal(defaultNames.includes("AskUserQuestion"), true);
  assert.equal(defaultNames.includes("spawn_code_executor"), true);
  assert.equal(defaultNames.length, 23);

  // Flash 模型也使用完整工具集
  const flashNames = getTools({ webSearchEnabled: true }).map((tool) => tool.function.name);
  assert.equal(flashNames.includes("WebSearch"), true);
  assert.equal(flashNames.includes("bash"), true);
  assert.equal(flashNames.includes("AskUserQuestion"), true);
  assert.equal(flashNames.includes("spawn_code_executor"), true);
  assert.equal(flashNames.length, 23);
});

test("getSystemPrompt always returns full prompt with all tool docs", () => {
  // 默认（无参数）
  const defaultPrompt = getSystemPrompt("/tmp/project");
  assert.equal(defaultPrompt.includes("## WebSearch"), true);
  assert.equal(defaultPrompt.includes("## Bash"), true);
  assert.equal(defaultPrompt.includes("交互式 CLI 工具"), true);

  // 带参数也返回完整提示词
  const promptWithOptions = getSystemPrompt("/tmp/project", { webSearchEnabled: true });
  assert.equal(promptWithOptions.includes("交互式 CLI 工具"), true);
  assert.equal(promptWithOptions.includes("## WebSearch"), true);
  assert.equal(promptWithOptions.includes("## Bash"), true);
});

test("getFlashAutoSwitchMessage indicates full tools and thinking enabled", () => {
  const msg = getFlashAutoSwitchMessage();
  assert.equal(msg.includes("deepseek-v4-flash"), true);
  // 消息中说明拥有全部工具和深度思考能力
  assert.equal(msg.includes("全部工具"), true);
  assert.equal(msg.includes("深度思考能力"), true);
});
