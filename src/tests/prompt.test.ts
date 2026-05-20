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
  assert.equal(defaultNames.includes("spawn_explorer"), false);
  // 不硬编码具体数字 —— 工具数量随新增功能自然增长
  assert.ok(defaultNames.length >= 22);

  // supervisorMode=true → 注册 spawn_code_executor + spawn_explorer
  const supervisorNames = getTools({ supervisorMode: true }).map((tool) => tool.function.name);
  assert.equal(supervisorNames.includes("spawn_code_executor"), true);
  assert.equal(supervisorNames.includes("spawn_explorer"), true);
  assert.equal(supervisorNames.length, defaultNames.length + 2);

  // supervisorMode=false → 不注册
  const noSupervisorNames = getTools({ supervisorMode: false }).map((tool) => tool.function.name);
  assert.equal(noSupervisorNames.includes("spawn_code_executor"), false);
  assert.equal(noSupervisorNames.includes("spawn_explorer"), false);
  assert.equal(noSupervisorNames.length, defaultNames.length);
});

test("getSystemPrompt 返回精简后的 prompt（工具摘要式），且 supervisorMode 条件注入委派策略", () => {
  // 普通模式（无 supervisorMode）
  const defaultPrompt = getSystemPrompt("/tmp/project");
  assert.equal(defaultPrompt.includes("交互式 CLI 工具"), true);
  assert.equal(defaultPrompt.includes("# 可用工具"), true);
  assert.equal(defaultPrompt.includes("- Bash:"), true);
  assert.equal(defaultPrompt.includes("- Grep:"), true);
  // 普通模式下不应包含 Supervisor-Worker 委派策略
  assert.equal(defaultPrompt.includes("Supervisor-Worker 模式"), false);
  assert.equal(defaultPrompt.includes("委派 Explorer"), false);

  // Supervisor 模式 → 应注入 CODE_EXECUTOR_GUIDANCE + EXPLORER_GUIDANCE
  const supervisorPrompt = getSystemPrompt("/tmp/project", { supervisorMode: true });
  assert.equal(supervisorPrompt.includes("Supervisor-Worker 模式"), true);
  assert.equal(supervisorPrompt.includes("委派 Explorer"), true);
  // 条件注入不影响公共前缀（缓存友好）
  assert.equal(supervisorPrompt.includes("交互式 CLI 工具"), true);
  assert.equal(supervisorPrompt.includes("- Bash:"), true);
});
