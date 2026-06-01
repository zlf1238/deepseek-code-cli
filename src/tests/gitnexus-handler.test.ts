import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecutionContext, ToolExecutionResult } from "../tools/executor";
import {
  handleGitnexusQuery,
  handleGitnexusContext,
  handleGitnexusImpact,
  handleGitnexusDetectChanges,
  handleGitnexusRename,
  handleGitnexusClusters,
  handleGitnexusProcesses,
} from "../tools/gitnexus-handler";

// ── 辅助函数 ─────────────────────────────────────────────

function createContext(projectRoot: string): ToolExecutionContext {
  return {
    sessionId: "gitnexus-test",
    projectRoot,
    toolCall: {
      id: "tool-call-id",
      type: "function",
      function: {
        name: "test",
        arguments: "{}"
      }
    },
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    })
  };
}

// ── 输入验证测试（不依赖 gitnexus MCP） ─────────────────

describe("gitnexus Query — 输入验证", () => {
  test("缺少 query 参数时返回错误", async () => {
    const result = await handleGitnexusQuery({}, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "query"/);
  });

  test("空 query 字符串时返回错误", async () => {
    const result = await handleGitnexusQuery({ query: "  " }, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "query"/);
  });
});

describe("gitnexus Context — 输入验证", () => {
  test("缺少 name 参数时返回错误", async () => {
    const result = await handleGitnexusContext({}, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "name"/);
  });

  test("空 name 字符串时返回错误", async () => {
    const result = await handleGitnexusContext({ name: "  " }, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "name"/);
  });
});

describe("gitnexus Impact — 输入验证", () => {
  test("缺少 target 参数时返回错误", async () => {
    const result = await handleGitnexusImpact({}, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "target"/);
  });

  test("空 target 字符串时返回错误", async () => {
    const result = await handleGitnexusImpact({ target: "  " }, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "target"/);
  });
});

// ── 端到端测试（依赖 gitnexus MCP 和已索引的代码库） ────
// 这些测试会调用真实的 gitnexus MCP 服务器，需要项目已索引

const PROJECT_ROOT = "/mnt/d/Java/IdeaProjects/deepseek-code-cli";

describe("gitnexus Query — 端到端", { timeout: 30_000 }, () => {
  test("搜索已知符号 SessionManager 返回结果", async () => {
    const result = await handleGitnexusQuery(
      { query: "SessionManager" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 100);
    assert.match(result.output!, /SessionManager/);
  });

  test("使用 max_chars 截断生效", async () => {
    const result = await handleGitnexusQuery(
      { query: "handleUserPrompt", max_chars: 500 },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length <= 500 + 200); // 截断后可能略超，包含 truncate 提示
  });
});

describe("gitnexus Context — 端到端", { timeout: 30_000 }, () => {
  test("获取 SessionManager 上下文返回结果", async () => {
    const result = await handleGitnexusContext(
      { name: "SessionManager" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 50);
    assert.match(result.output!, /SessionManager/);
  });

  test("使用 max_chars 截断生效", async () => {
    const result = await handleGitnexusContext(
      { name: "activateSession", max_chars: 300 },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length <= 300 + 200);
  });
});

describe("gitnexus Impact — 端到端", { timeout: 30_000 }, () => {
  test("使用符号名作为 target 返回影响面", async () => {
    const result = await handleGitnexusImpact(
      { target: "handleUserPrompt" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 100);
    assert.match(result.output!, /impactedCount/);
  });

  test("使用文件路径 + symbol 参数返回影响面", async () => {
    const result = await handleGitnexusImpact(
      { target: "src/session.ts", symbol: "activateSession" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 100);
    assert.match(result.output!, /impactedCount/);
    // 验证参数映射正确：symbol 被用作 target
    assert.match(result.output!, /activateSession/);
  });

  test("使用 direction=upstream 参数", async () => {
    const result = await handleGitnexusImpact(
      { target: "handleUserPrompt", direction: "upstream" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    // upstream 表示谁依赖它，数量通常较少但至少应有结果
    assert.match(result.output!, /impactedCount/);
  });
});

describe("gitnexus Clusters — 端到端", { timeout: 30_000 }, () => {
  test("列出所有聚类返回聚类列表", async () => {
    const result = await handleGitnexusClusters({}, createContext(PROJECT_ROOT));
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 50);
    // 至少应包含一些已知聚类
    assert.match(result.output!, /Tools/);
    assert.match(result.output!, /Ui/);
  });

  test("指定聚类名称返回详情", async () => {
    const result = await handleGitnexusClusters(
      { cluster: "Tools" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    // 如果返回数据则检查格式，也可返回空（gitnexus 可能不支持单个聚类详情）
    // 至少不报错
  });
});

describe("gitnexus Processes — 端到端", { timeout: 30_000 }, () => {
  test("列出所有流程返回流程列表", async () => {
    const result = await handleGitnexusProcesses({}, createContext(PROJECT_ROOT));
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 50);
    // 至少应包含一些流程名
    assert.match(result.output!, /processes/);
  });

  test("指定流程名称返回详情", async () => {
    const result = await handleGitnexusProcesses(
      { process: "ActivateSession → GetProjectCode" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    // 至少不报错
  });
});

describe("gitnexus DetectChanges — 端到端", { timeout: 30_000 }, () => {
  test("无参数时使用默认 scope 正常工作", async () => {
    const result = await handleGitnexusDetectChanges({}, createContext(PROJECT_ROOT));
    assert.equal(result.ok, true);
    assert.ok(result.output);
  });

  test("指定 scope=all 正常返回", async () => {
    const result = await handleGitnexusDetectChanges(
      { scope: "all" },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 50);
    assert.match(result.output!, /changed_count|summary|affected_count/);
  });
});

describe("gitnexus Rename — 输入验证", () => {
  test("缺少 new_name 时返回错误", async () => {
    const result = await handleGitnexusRename({}, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "new_name"/);
  });

  test("空 new_name 时返回错误", async () => {
    const result = await handleGitnexusRename({ new_name: "  " }, createContext("/tmp"));
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Missing required "new_name"/);
  });
});

describe("gitnexus Rename — 端到端", { timeout: 30_000 }, () => {
  test("dry_run 模式返回重命名预览", async () => {
    const result = await handleGitnexusRename(
      { symbol_name: "handleUserPrompt", new_name: "handleUserPromptTest", dry_run: true },
      createContext(PROJECT_ROOT)
    );
    assert.equal(result.ok, true);
    assert.ok(result.output);
    assert.ok(result.output!.length > 50);
    assert.match(result.output!, /status|files_affected|changes/);
  });
});
