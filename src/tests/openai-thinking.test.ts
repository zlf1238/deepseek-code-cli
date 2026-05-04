import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingRequestOptions } from "../openai-thinking";

test("buildThinkingRequestOptions returns no thinking payload when disabled", () => {
  assert.deepEqual(buildThinkingRequestOptions(false, "https://api.example.com"), {});
});

test("buildThinkingRequestOptions keeps top-level thinking for volces endpoints", () => {
  assert.deepEqual(
    buildThinkingRequestOptions(true, "https://ark.cn-beijing.volces.com/api/v3"),
    {
      thinking: { type: "enabled" },
      extra_body: { reasoning_effort: "max" }
    }
  );
});

test("buildThinkingRequestOptions uses extra_body for non-volces endpoints", () => {
  assert.deepEqual(
    buildThinkingRequestOptions(true, "https://api.deepseek.com"),
    {
      extra_body: {
        thinking: { type: "enabled" },
        reasoning_effort: "max"
      }
    }
  );
});

test("buildThinkingRequestOptions accepts high reasoning effort", () => {
  assert.deepEqual(
    buildThinkingRequestOptions(true, "https://api.deepseek.com", "high"),
    {
      extra_body: {
        thinking: { type: "enabled" },
        reasoning_effort: "high"
      }
    }
  );
});
