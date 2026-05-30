import { test } from "node:test";
import assert from "node:assert/strict";
import { getSystemPrompt, getTools } from "../prompt";

test("getTools 返回核心工具集合，不包含 spawn_code_executor", () => {
  const defaultNames = getTools().map((tool) => tool.function.name);
  assert.equal(defaultNames.includes("WebSearch"), true);
  assert.equal(defaultNames.includes("bash"), true);
  assert.equal(defaultNames.includes("AskUserQuestion"), true);
  assert.equal(defaultNames.includes("SkillLoad"), true);
  // 确认 spawn_code_executor 已移除
  assert.equal(defaultNames.includes("spawn_code_executor"), false);
  assert.equal(defaultNames.includes("spawn_explorer"), false);
  // 不硬编码具体数字 —— 工具数量随新增功能自然增长
  assert.ok(defaultNames.length >= 22);
});

test("getSystemPrompt 返回精简 prompt，不包含 Supervisor-Worker 委派策略", () => {
  const prompt = getSystemPrompt("/tmp/project");
  assert.equal(prompt.includes("交互式 CLI 工具"), true);
  assert.equal(prompt.includes("# 可用工具"), true);
  assert.equal(prompt.includes("- Bash:"), true);
  assert.equal(prompt.includes("- Grep:"), true);
  // 确认 CODE_EXECUTOR_GUIDANCE 已移除
  assert.equal(prompt.includes("Supervisor-Worker 模式"), false);
  assert.equal(prompt.includes("spawn_code_executor"), false);
  assert.equal(prompt.includes("委派 Explorer"), false);
});
