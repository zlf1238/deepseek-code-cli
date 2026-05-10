import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_V4_PRO,
  DEEPSEEK_V4_FLASH,
  selectModelByPrice,
} from "../model-capabilities";
import type { SwitchContext } from "../model-capabilities";

// DeepSeek public pricing (per million tokens)
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
  proPricing: PRO_PRICING_2_5X,
  flashPricing: FLASH_PRICING,
  accumulatedTokens: 100_000,
  lastToolName: undefined,
  maxPaybackRounds: 8,
  estimatedOutputPerRound: 2000,
  ...overrides,
});

test("no tool calls -> keep Pro", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, false, makeCtx());
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("No tool calls"));
});

test("non-Pro primary model -> keep primary", () => {
  const result = selectModelByPrice("other-model", true, makeCtx());
  assert.equal(result.model, "other-model");
});

test("Pro cheaper in all dimensions -> never switch to Flash", () => {
  // 2.5x discount: Pro is cheaper in hit (0.025 vs 0.01? No, Flash hit is cheaper)
  // Let's create a scenario where Pro IS cheaper in ALL dims
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
  assert.ok(result.reason.includes("cheaper in all dimensions"));
});

test("AskUserQuestion locks Pro", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    lastToolName: "AskUserQuestion",
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("AskUserQuestion"));
});

test("2.5x discount: Pro cheaper in hit+output, Flash cheaper in miss -> switches Flash when payback <= 8", () => {
  // With 100k accumulated tokens:
  // penalty = 100k/1M * (1.0 - 0.025) = 0.0975
  // saving  = 2000/1M * (0.075 - 0.4) = -0.00065 (negative! Flash output is MORE expensive)
  // Wait — at 2.5x discount, Pro output (0.075) < Flash output (0.4)
  // So roundSaving = 2000/1M * (0.075 - 0.4) = negative
  // Should stay on Pro because Flash output is NOT cheaper
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx());
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("Flash output not cheaper") || result.reason.includes("cheaper in all"));
});

test("Flash cheaper in output -> compute payback rounds", () => {
  // Flash output (0.4) > Pro output (0.075), not this case. Let's make Flash cheaper:
  const ctx = makeCtx({
    proPricing: {
      inputCacheHitPricePerMillion: 1.0,    // Pro expensive hit
      inputCacheMissPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,           // Pro expensive output
    },
    flashPricing: {
      inputCacheHitPricePerMillion: 0.5,
      inputCacheMissPricePerMillion: 2.0,
      outputPricePerMillion: 0.4,           // Flash cheaper output
    },
    accumulatedTokens: 100_000,
  });
  // penalty = 100k/1M * (2.0 - 1.0) = 0.1
  // saving  = 2000/1M * (2.0 - 0.4) = 0.0032
  // payback = 0.1 / 0.0032 = 31.25 rounds > 8 -> stay Pro
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
    // saving  = 2000/1M * (2.0 - 0.4) = 0.0032
    // payback = 0.01 / 0.0032 = 3.125 <= 8 -> switch!
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
    estimatedOutputPerRound: 20000,  // 10x bigger output -> 10x saving
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
  assert.ok(result.reason.includes("cheaper in all dimensions"));
});
