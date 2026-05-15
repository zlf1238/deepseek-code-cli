import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemPrompt, getTools } from "../prompt";

test("getTools includes spawn_code_executor only when supervisorMode is true", () => {
  // 默认（不含 supervisorMode）→ 不注册 spawn_code_executor
  const defaultNames = getTools().map((tool) => tool.function.name);
  assert.equal(defaultNames.includes("WebSearch"), true);
  assert.equal(defaultNames.includes("bash"), true);
  assert.equal(defaultNames.includes("AskUserQuestion"), true);
  assert.equal(defaultNames.includes("spawn_code_executor"), false);
  assert.equal(defaultNames.length, 22);

  // supervisorMode=true → 注册 spawn_code_executor
  const supervisorNames = getTools({ supervisorMode: true }).map((tool) => tool.function.name);
  assert.equal(supervisorNames.includes("spawn_code_executor"), true);
  assert.equal(supervisorNames.length, 23);

  // supervisorMode=false → 不注册
  const noSupervisorNames = getTools({ supervisorMode: false }).map((tool) => tool.function.name);
  assert.equal(noSupervisorNames.includes("spawn_code_executor"), false);
  assert.equal(noSupervisorNames.length, 22);
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
