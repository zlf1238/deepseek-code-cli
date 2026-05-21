import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSummary, formatElapsed } from "../ui/completionSummary";
import type { SessionEntry } from "../session";
import type { PricingConfig } from "../settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_PRICING: Required<PricingConfig> = {
  inputPricePerMillion: 0, outputPricePerMillion: 0,
  inputCacheHitPricePerMillion: 0, inputCacheMissPricePerMillion: 0,
};
const WITH_PRICING: Required<PricingConfig> = {
  inputPricePerMillion: 0.27, outputPricePerMillion: 1.10,
  inputCacheHitPricePerMillion: 0, inputCacheMissPricePerMillion: 0,
};
const WITH_CACHE_PRICING: Required<PricingConfig> = {
  inputPricePerMillion: 0.27, outputPricePerMillion: 1.10,
  inputCacheHitPricePerMillion: 0.07, inputCacheMissPricePerMillion: 0.27,
};

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

test("formatElapsed returns sub-second precision for values below 60s", () => {
  assert.equal(formatElapsed(0), "0.0s");
  assert.equal(formatElapsed(500), "0.5s");
  assert.equal(formatElapsed(1234), "1.2s");
  assert.equal(formatElapsed(59300), "59.3s");
});

test("formatElapsed switches to minutes:seconds at 60s", () => {
  assert.equal(formatElapsed(60000), "1m0s");
  assert.equal(formatElapsed(60001), "1m0s");
  assert.equal(formatElapsed(120000), "2m0s");
});

test("formatElapsed formats longer durations", () => {
  assert.equal(formatElapsed(125000), "2m5s");
  assert.equal(formatElapsed(3600000), "60m0s");
  assert.equal(formatElapsed(3661000), "61m1s");
});

// ---------------------------------------------------------------------------
// buildCompletionSummary
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "session-1",
    summary: "test summary",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    activeTokens: 0,
    compactThreshold: 0,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
    processes: null,
    ...overrides
  };
}

test("buildCompletionSummary includes elapsed time and token count for completed session", () => {
  const session = makeSession({
    usage: { total_tokens: 1234 }
  });
  const msg = buildCompletionSummary(session, 5230, 1234, 1000, 234, 0, 0, NO_PRICING);

  assert.equal(msg.role, "system");
  assert.equal(msg.visible, true);
  assert.equal(msg.meta?.isSummary, true);
  // 新格式: ✓ 5.2s · 输入 1.0k/输出 234
  assert.ok(msg.content?.startsWith("✓ 5.2s"));
  assert.ok(msg.content?.includes("输入 1.0k/输出 234"));
  assert.equal((msg.messageParams as any)?.statusColor, "green");
});

test("buildCompletionSummary shows failed status in red", () => {
  const session = makeSession({
    status: "failed",
    usage: { total_tokens: 500 }
  });
  const msg = buildCompletionSummary(session, 3000, 500, 400, 100, 0, 0, NO_PRICING);

  // 新格式: ✗ 3.0s · ...
  assert.ok(msg.content?.startsWith("✗ 3.0s"));
  assert.equal((msg.messageParams as any)?.statusColor, "red");
});

test("buildCompletionSummary shows interrupted status in yellow", () => {
  const session = makeSession({
    status: "interrupted",
    usage: { total_tokens: 800 }
  });
  const msg = buildCompletionSummary(session, 15000, 800, 600, 200, 0, 0, NO_PRICING);

  // 新格式: ⚠ 15.0s · ...
  assert.ok(msg.content?.startsWith("⚠ 15.0s"));
  assert.equal((msg.messageParams as any)?.statusColor, "yellow");
});

test("buildCompletionSummary omits cost when pricing is zero and no tokens", () => {
  const session = makeSession({ status: "completed" });
  const msg = buildCompletionSummary(session, 1000, 1000, 800, 200, 0, 0, NO_PRICING);

  // 新格式: ✓ 1.0s · 输入 800/输出 200
  assert.ok(msg.content?.startsWith("✓ 1.0s"));
  assert.ok(msg.content?.includes("输入 800/输出 200"));
  assert.ok(!msg.content?.includes("¥"));
});

test("buildCompletionSummary calculates cost with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 800k input at 0.27/1M + 200k output at 1.10/1M = 0.216 + 0.220 = 0.436
  const msg = buildCompletionSummary(session, 5000, 1_000_000, 800_000, 200_000, 0, 0, WITH_PRICING);

  assert.ok(msg.content?.includes("输入 800k/输出 200k"));
  // 新格式: ¥0.436
  assert.ok(msg.content?.includes("¥0.436"));
});

test("buildCompletionSummary handles large token counts with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 1M input at 0.27 + 2M output at 1.10 = 0.27 + 2.20 = 2.47
  const msg = buildCompletionSummary(session, 300000, 3_000_000, 1_000_000, 2_000_000, 0, 0, WITH_PRICING);

  assert.ok(msg.content?.includes("输入 1M/输出 2M"));
  assert.ok(msg.content?.includes("¥2.47"));
});

test("buildCompletionSummary shows cache hit rate", () => {
  const session = makeSession({ status: "completed" });
  // 900k cache hit + 100k cache miss = 90%
  const msg = buildCompletionSummary(session, 5000, 1_000_000, 1_000_000, 0, 900_000, 100_000, WITH_PRICING);

  // 新格式: 缓存 90%
  assert.ok(msg.content?.includes("缓存 90%"));
});

test("buildCompletionSummary includes cache info inline with model breakdown", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": {
      prompt_tokens: 100_000,
      completion_tokens: 50_000,
      prompt_cache_hit_tokens: 30_000,
      prompt_cache_miss_tokens: 70_000,
    },
  };
  const msg = buildCompletionSummary(
    session, 5000, 150_000, 100_000, 50_000, 30_000, 70_000, WITH_CACHE_PRICING,
    usageByModelDiff, (_name: string) => WITH_CACHE_PRICING,
  );

  // 新格式: ✓ 5.0s · deepseek-v4-pro: 输入 100k/输出 50k · 缓存 30% · ¥0.076
  assert.ok(msg.content?.includes("deepseek-v4-pro: 输入 100k/输出 50k"));
  assert.ok(msg.content?.includes("缓存 30%"));
  assert.ok(msg.content?.includes("¥0.076"));
});

test("buildCompletionSummary shows per-model cost when usageByModelDiff has multiple models", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": {
      prompt_tokens: 100_000,
      completion_tokens: 50_000,
      prompt_cache_hit_tokens: 30_000,
      prompt_cache_miss_tokens: 70_000,
    },
    "deepseek-v4-flash": {
      prompt_tokens: 20_000,
      completion_tokens: 10_000,
      prompt_cache_hit_tokens: 5_000,
      prompt_cache_miss_tokens: 15_000,
    },
  };
  // deepseek-v4-pro (WITH_CACHE_PRICING): (30k*0.07 + 70k*0.27 + 50k*1.10)/1M = 0.0021+0.0189+0.055 = 0.076
  // deepseek-v4-flash (mock rates): (5k*0.01 + 15k*0.05 + 10k*0.20)/1M = 0.00005+0.00075+0.002 = 0.0028
  const mockResolvePricing = (name: string) => {
    if (name === "deepseek-v4-flash") {
      return {
        inputPricePerMillion: 0.05, outputPricePerMillion: 0.20,
        inputCacheHitPricePerMillion: 0.01, inputCacheMissPricePerMillion: 0.05,
      };
    }
    return WITH_CACHE_PRICING;
  };

  const msg = buildCompletionSummary(
    session, 5000, 180_000, 120_000, 60_000, 35_000, 85_000, WITH_CACHE_PRICING,
    usageByModelDiff, mockResolvePricing,
  );

  // 新格式: 各模型信息 inline，无单独模型费用标记行
  assert.ok(msg.content?.includes("deepseek-v4-pro: 输入 100k/输出 50k"));
  assert.ok(msg.content?.includes("deepseek-v4-flash: 输入 20k/输出 10k"));
  // 总缓存: 35k/(35k+85k) = 29%
  assert.ok(msg.content?.includes("缓存 29%"));
  // 总费用: 0.076 + 0.0028 = 0.0788
  assert.ok(msg.content?.includes("¥0.079"));
});

test("buildCompletionSummary does not show model breakdown for single model diff", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": { prompt_tokens: 100, completion_tokens: 50 },
  };
  const msg = buildCompletionSummary(
    session, 1000, 150, 100, 50, 0, 0, NO_PRICING,
    usageByModelDiff, (_name: string) => NO_PRICING,
  );

  // 单模型信息已 inline
  assert.ok(msg.content?.includes("deepseek-v4-pro: 输入 100/输出 50"));
});

test("buildCompletionSummary uses correct per-model rates for flash vs pro", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": { prompt_tokens: 100_000, completion_tokens: 50_000 },
    "deepseek-v4-flash": { prompt_tokens: 80_000, completion_tokens: 30_000 },
  };
  const mockResolvePricing = (name: string) => {
    if (name === "deepseek-v4-flash") {
      return {
        inputPricePerMillion: 0.05, outputPricePerMillion: 0.20,
        inputCacheHitPricePerMillion: 0.01, inputCacheMissPricePerMillion: 0.05,
      };
    }
    return WITH_CACHE_PRICING;
  };
  const msg = buildCompletionSummary(
    session, 5000, 260_000, 180_000, 80_000, 0, 0, WITH_CACHE_PRICING,
    usageByModelDiff, mockResolvePricing,
  );
  // pro: completion 50k * 1.10/1M = 0.055 (cache=0, 无 input uncached 计费)
  // flash: completion 30k * 0.20/1M = 0.006
  // 总费用: 0.055 + 0.006 = 0.061
  assert.ok(msg.content?.includes("deepseek-v4-pro: 输入 100k/输出 50k"));
  assert.ok(msg.content?.includes("deepseek-v4-flash: 输入 80k/输出 30k"));
  assert.ok(msg.content?.includes("¥0.061"));
});
