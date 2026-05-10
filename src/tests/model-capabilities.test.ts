import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_V4_PRO,
  DEEPSEEK_V4_FLASH,
  selectModelByPrice,
} from "../model-capabilities";
import type { SwitchContext } from "../model-capabilities";

// DeepSeek 公开定价（每百万 token）
const PRO_PRICING_2_5X = {
  inputCacheHitPricePerMillion: 0.025,
  inputCacheMissPricePerMillion: 0.25,
  outputPricePerMillion: 0.075,
};
const FLASH_PRICING = {
  inputCacheHitPricePerMillion: 0.01,
  inputCacheMissPricePerMillion: 1.0,
  outputPricePerMillion: 0.4,
};

const makeCtx = (overrides: Partial<SwitchContext> = {}): SwitchContext => ({
  enabled: true,
  proPricing: PRO_PRICING_2_5X,
  flashPricing: FLASH_PRICING,
  accumulatedTokens: 100_000,
  lastToolName: undefined,
  maxPaybackRounds: 8,
  estimatedOutputPerRound: 20000,
  ...overrides,
});

test("no tool calls -> keep Pro", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, false, makeCtx());
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("尚无工具调用"));
});

test("non-Pro primary model -> keep primary", () => {
  const result = selectModelByPrice("other-model", true, makeCtx());
  assert.equal(result.model, "other-model");
});

test("Pro cheaper in all dimensions -> never switch to Flash", () => {
  // 2.5x 折扣：Pro 在 hit 上更便宜（0.025 vs 0.01? 不，Flash hit 更便宜）
  // 构造一个 Pro 在所有维度都更便宜的情形
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 0.01,   // cheaper
      inputCacheMissPricePerMillion: 0.5,   // cheaper
      outputPricePerMillion: 0.2,           // cheaper
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.05,
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 0.4,
    },
  });
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("全部维度更便宜"));
});

test("AskUserQuestion locks Pro", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    lastToolName: "AskUserQuestion",
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("AskUserQuestion"));
});

test("2.5x discount: Flash only cheaper in cacheHit -> stay on Pro", () => {
  // 累积 100k tokens 时：
  // penalty = 100k/1M * (1.0 - 0.025) = 0.0975
  // saving  = 20000/1M * (0.075 - 0.4) = -0.0065（负数——Flash 输出反而更贵）
  // Pro 在输出上更便宜（0.075 < 0.4），故 roundSaving < 0
  // 因此留在 Pro，因为 Flash 输出不便宜
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx());
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("Flash 输出价格更高") || result.reason.includes("全部维度更便宜"));
});

test("Flash cheaper in output (high penalty) -> stay on Pro", () => {
  // Flash 输出（0.4）> Pro 输出（0.075），不是这种情况。我们让 Flash 更便宜：
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,    // Pro expensive hit
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,           // Pro expensive output
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.5,
      inputCacheMissPricePerMillion: 2.0,
      outputPricePerMillion: 0.4,           // Flash 输出更便宜
    },
    accumulatedTokens: 260_000,
    // penalty = 260k/1M * (2.0 - 1.0) = 0.26
    // saving  = 20000/1M * (2.0 - 0.4) = 0.032
    // payback = 0.26 / 0.032 = 8.125 > 8 -> 留在 Pro
  });
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.paybackRounds > 8);
});

test("Low accumulated tokens -> switch to Flash (low penalty)", () => {
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.5,
      inputCacheMissPricePerMillion: 2.0,
      outputPricePerMillion: 0.4,
    },
    accumulatedTokens: 10_000,
    // penalty = 10k/1M * (2.0 - 1.0) = 0.01
    // saving  = 20000/1M * (2.0 - 0.4) = 0.032
    // payback = 0.01 / 0.032 = 0.3125 <= 8 -> 切换！
  });
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.paybackRounds <= 8);
});

test("maxPaybackRounds=0 -> never switch", () => {
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.5,
      inputCacheMissPricePerMillion: 2.0,
      outputPricePerMillion: 0.4,
    },
    accumulatedTokens: 10_000,
    maxPaybackRounds: 0,
  });
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  assert.equal(result.model, DEEPSEEK_V4_PRO);
});

test("estimatedOutputPerRound affects payback calculation", () => {
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.5,
      inputCacheMissPricePerMillion: 2.0,
      outputPricePerMillion: 0.4,
    },
    accumulatedTokens: 10_000,
    estimatedOutputPerRound: 20000,  // 10 倍输出 -> 10 倍节省
    // saving = 20000/1M * (2.0 - 0.4) = 0.032
    // payback = 0.01 / 0.032 = 0.3125 <= 8 -> switch
  });
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
});

test("equal pricing in all dimensions -> stay on Pro (not cheaper, but equal)", () => {
  const equal = {
    inputCacheHitPricePerMillion: 1.0,
    inputCacheMissPricePerMillion: 2.0,
    outputPricePerMillion: 0.5,
  };
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    proPricing: equal,
    flashPricing: equal,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("全部维度更便宜"));
});

test("enabled=false -> always stay on Pro regardless of pricing", () => {
  // 即便 Flash 在所有维度都更便宜，禁用自动切换后也应留在 Pro
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    enabled: false,
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.01,
      inputCacheMissPricePerMillion: 0.01,
      outputPricePerMillion: 0.01,
    },
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("自动切换已禁用"));
});
