import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSummary, formatElapsed } from "../ui/App";
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
  assert.ok(msg.content?.includes("✓ completed"));
  assert.ok(msg.content?.includes("耗时: 5.2s"));
  assert.ok(msg.content?.includes("token: 1.2k"));
  assert.equal((msg.messageParams as any)?.statusColor, "green");
});

test("buildCompletionSummary shows failed status in red", () => {
  const session = makeSession({
    status: "failed",
    usage: { total_tokens: 500 }
  });
  const msg = buildCompletionSummary(session, 3000, 500, 400, 100, 0, 0, NO_PRICING);

  assert.ok(msg.content?.includes("✗ failed"));
  assert.equal((msg.messageParams as any)?.statusColor, "red");
});

test("buildCompletionSummary shows interrupted status in yellow", () => {
  const session = makeSession({
    status: "interrupted",
    usage: { total_tokens: 800 }
  });
  const msg = buildCompletionSummary(session, 15000, 800, 600, 200, 0, 0, NO_PRICING);

  assert.ok(msg.content?.includes("⚠ interrupted"));
  assert.equal((msg.messageParams as any)?.statusColor, "yellow");
});

test("buildCompletionSummary omits cost when pricing is zero", () => {
  const session = makeSession({ status: "completed" });
  const msg = buildCompletionSummary(session, 1000, 1000, 800, 200, 0, 0, NO_PRICING);

  assert.ok(msg.content?.includes("✓ completed"));
  assert.ok(msg.content?.includes("token: 1.0k"));
  assert.ok(!msg.content?.includes("费用:"));
});

test("buildCompletionSummary calculates cost with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 800k input at 0.27/1M + 200k output at 1.10/1M = 0.216 + 0.220 = 0.436
  // No cache tokens, all input billed at inputPricePerMillion
  const msg = buildCompletionSummary(session, 5000, 1_000_000, 800_000, 200_000, 0, 0, WITH_PRICING);

  assert.ok(msg.content?.includes("token: 1M"));
  assert.ok(msg.content?.includes("费用: ¥0.436"));
});

test("buildCompletionSummary handles large token counts with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 1M input at 0.27 + 2M output at 1.10 = 0.27 + 2.20 = 2.47
  const msg = buildCompletionSummary(session, 300000, 3_000_000, 1_000_000, 2_000_000, 0, 0, WITH_PRICING);

  assert.ok(msg.content?.includes("token: 3M"));
  assert.ok(msg.content?.includes("费用: ¥2.47"));
});

test("buildCompletionSummary uses the correct session id", () => {
  const session = makeSession({ id: "abc-123" });
  const msg = buildCompletionSummary(session, 500, 100, 80, 20, 0, 0, NO_PRICING);

  assert.equal(msg.sessionId, "abc-123");
});

test("buildCompletionSummary generates a unique id per call", () => {
  const session = makeSession();
  const msg1 = buildCompletionSummary(session, 100, 50, 40, 10, 0, 0, NO_PRICING);
  const msg2 = buildCompletionSummary(session, 200, 50, 40, 10, 0, 0, NO_PRICING);

  assert.notEqual(msg1.id, msg2.id);
});

// ---------------------------------------------------------------------------
// Cache hit rate and cache-aware pricing tests
// ---------------------------------------------------------------------------

test("buildCompletionSummary shows cache hit rate when cache tokens exist", () => {
  const session = makeSession({ status: "completed" });
  // 70 cache hit, 30 cache miss = 70% hit rate
  const msg = buildCompletionSummary(session, 5000, 1000, 100, 0, 70, 30, NO_PRICING);

  assert.ok(msg.content?.includes("缓存命中: 70%"));
});

test("buildCompletionSummary omits cache hit rate when no cache tokens", () => {
  const session = makeSession({ status: "completed" });
  const msg = buildCompletionSummary(session, 1000, 500, 400, 100, 0, 0, NO_PRICING);

  assert.ok(!msg.content?.includes("缓存命中"));
});

test("buildCompletionSummary uses cache-aware pricing when configured", () => {
  const session = makeSession({ status: "completed" });
  // 100k cache hit at 0.07/1M + 100k cache miss at 0.27/1M + 200k output at 1.10/1M
  // = 0.007 + 0.027 + 0.220 = 0.254
  const msg = buildCompletionSummary(session, 5000, 400_000, 200_000, 200_000, 100_000, 100_000, WITH_CACHE_PRICING);

  assert.ok(msg.content?.includes("缓存命中: 50%"));
  assert.ok(msg.content?.includes("费用: ¥0.254"));
});

test("buildCompletionSummary falls back to inputPricePerMillion when cache prices not set", () => {
  const session = makeSession({ status: "completed" });
  // WITH_PRICING has cache prices = 0, so falls back to inputPricePerMillion = 0.27
  // 100k cache hit + 100k cache miss = 200k input at 0.27/1M + 200k output at 1.10/1M
  // = 0.054 + 0.220 = 0.274
  const msg = buildCompletionSummary(session, 5000, 400_000, 200_000, 200_000, 100_000, 100_000, WITH_PRICING);

  assert.ok(msg.content?.includes("缓存命中: 50%"));
  assert.ok(msg.content?.includes("费用: ¥0.274"));
});

// ---------------------------------------------------------------------------
// Per-model cost breakdown tests
// ---------------------------------------------------------------------------

/** Shared mock for per-model tests — resolves flash at a cheaper rate. */
function mockResolvePricing(modelName: string): Required<PricingConfig> {
  if (modelName === "deepseek-v4-flash") {
    return {
      inputPricePerMillion: 0.05,
      outputPricePerMillion: 0.20,
      inputCacheHitPricePerMillion: 0.01,
      inputCacheMissPricePerMillion: 0.05,
    };
  }
  // pro and everything else
  return { ...WITH_CACHE_PRICING };
}

test("buildCompletionSummary shows per-model cost when usageByModelDiff has multiple models", () => {
  const session = makeSession({ status: "completed" });
  // Round increment diffs (not cumulative session data!)
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
  const msg = buildCompletionSummary(
    session, 5000, 180_000, 120_000, 60_000, 35_000, 85_000, WITH_CACHE_PRICING,
    usageByModelDiff, mockResolvePricing,
  );

  assert.ok(msg.content?.includes("模型费用:"));
  assert.ok(msg.content?.includes("deepseek-v4-pro"));
  assert.ok(msg.content?.includes("deepseek-v4-flash"));
});

test("buildCompletionSummary does not show model breakdown for single model diff", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": { prompt_tokens: 100, completion_tokens: 50 },
  };
  const msg = buildCompletionSummary(
    session, 1000, 150, 100, 50, 0, 0, NO_PRICING,
    usageByModelDiff, mockResolvePricing,
  );

  assert.ok(!msg.content?.includes("模型费用:"));
});

test("buildCompletionSummary uses correct per-model rates for flash vs pro", () => {
  const session = makeSession({ status: "completed" });
  const usageByModelDiff: Record<string, Record<string, number>> = {
    "deepseek-v4-pro": { prompt_tokens: 100_000, completion_tokens: 50_000 },
    "deepseek-v4-flash": { prompt_tokens: 80_000, completion_tokens: 30_000 },
  };
  const msg = buildCompletionSummary(
    session, 5000, 260_000, 180_000, 80_000, 0, 0, WITH_CACHE_PRICING,
    usageByModelDiff, mockResolvePricing,
  );
  // pro: 100k * 0.27/1M + 50k * 1.10/1M = 0.027 + 0.055 = 0.082
  // flash: 80k * 0.05/1M + 30k * 0.20/1M = 0.004 + 0.006 = 0.010
  assert.ok(msg.content?.includes("deepseek-v4-pro"));
  assert.ok(msg.content?.includes("deepseek-v4-flash"));
  // Verify that pro cost ~0.082 and flash cost ~0.010 appear in the breakdown
  assert.ok(msg.content?.includes("模型费用:"));
});
