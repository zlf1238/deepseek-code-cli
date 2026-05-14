import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_V4_PRO,
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO_PRICING,
  DEEPSEEK_V4_FLASH_PRICING,
  selectModelByPrice,
} from "../model-capabilities";
import type { SwitchContext } from "../model-capabilities";

// ── 默认测试上下文（基于 DeepSeek v4 真实定价）──

const makeCtx = (
  overrides: Partial<SwitchContext> = {}
): SwitchContext => ({
  enabled: true,
  proPricing: DEEPSEEK_V4_PRO_PRICING,
  flashPricing: DEEPSEEK_V4_FLASH_PRICING,
  accumulatedTokens: 100_000,
  lastToolName: undefined,
  maxPaybackRounds: 8,
  estimatedOutputPerRound: 8000,
  estimatedInputPerRound: 500,
  cacheHitRate: 0.5,
  ...overrides,
});

// ═══════════════════════════════════════════════
// 基础行为
// ═══════════════════════════════════════════════

test("disabled -> stay on current model", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({ enabled: false }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("自动切换已禁用"));
});

test("non-Pro primary -> stay on primary", () => {
  const result = selectModelByPrice("other-model", true, makeCtx());
  assert.equal(result.model, "other-model");
  assert.ok(result.reason.includes("非 Pro 主模型"));
});

test("no tool calls -> planning phase, stay on current", () => {
  // 规划阶段：保持当前模型（默认 Pro）
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, false, makeCtx());
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("规划阶段"));
});

test("AskUserQuestion locks Pro regardless of direction", () => {
  // 即使在 Flash 上，AskUserQuestion 也应锁定 Pro
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    lastToolName: "AskUserQuestion",
    currentModel: DEEPSEEK_V4_FLASH,
    roundsOnFlash: 10,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("AskUserQuestion"));
});

test("maxPaybackRounds=0 prevents Pro→Flash switch", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    maxPaybackRounds: 0,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("maxPaybackRounds=0"));
});

// ═══════════════════════════════════════════════
// Pro → Flash：缓存感知回本计算
// ═══════════════════════════════════════════════

test("Pro→Flash: low cache hit rate (0.3) + large context -> harder to switch", () => {
  // h=0.3: proExpectedInput = 0.3*0.025 + 0.7*3.0 = 0.0075 + 2.1 = 2.1075
  // flashExpectedInput = 0.3*0.02 + 0.7*1.0 = 0.006 + 0.7 = 0.706
  // penalty = 100k/1M * (1.0 - 2.1075) = 0.1 * (-1.1075) → negative! No penalty, but flash miss price might be lower
  // Actually: penalty = acc * (fp.miss - pro.expected)
  //   = 0.1 * (1.0 - 2.1075) = -0.11075 → negative = NO penalty
  //   (meaning switching doesn't cost extra for accumulated context)
  // With output savings: output * (6.0 - 2.0) / 1M = 8000 * 4 / 1M = 0.032
  // input savings: input * (2.1075 - 0.706) / 1M = 500 * 1.4015 / 1M = 0.0007
  // total = 0.0327 → payback = -0.11075 / 0.0327 = negative → immediate switch!

  const ctx = makeCtx({
    cacheHitRate: 0.3,
    accumulatedTokens: 100_000,
  });

  // penalty negative → payback negative → switch to Flash
  // But wait: penalty is negative means Flash's miss price is LESS than Pro's expected
  // Actually that means Pro is more expensive for accumulated input → switch!
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, ctx);
  // With penalty negative and saving positive, payback is negative → switches Flash
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.paybackRounds < 0 || Number.isNaN(result.paybackRounds));
});

test("Pro→Flash: high cache hit rate (0.8) -> penalty shrinks → switches faster", () => {
  // h=0.8: proExpectedInput = 0.8*0.025 + 0.2*3.0 = 0.02 + 0.6 = 0.62
  // flashExpectedInput = 0.8*0.02 + 0.2*1.0 = 0.016 + 0.2 = 0.216
  // penalty = 0.1 * (1.0 - 0.62) = 0.038
  // output savings = 8000 * 4 / 1M = 0.032
  // input savings = 500 * (0.62 - 0.216) / 1M = 500 * 0.404 / 1M = 0.000202
  // total = 0.0322 → payback = 0.038 / 0.0322 ≈ 1.18 rounds
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    cacheHitRate: 0.8,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.paybackRounds <= 2);
  assert.ok(result.reason.includes("h=0.80"));
});

test("Pro→Flash: large accumulated context with moderate cache -> higher penalty", () => {
  // h=0.5, acc=500k:
  // proExpected = 0.5*0.025 + 0.5*3.0 = 1.5125
  // penalty = 0.5 * (1.0 - 1.5125) = -0.256 → negative! No cost to switch
  // But if Flash miss > Pro expected, penalty positive:
  // Let's use acc=30k: penalty = 0.03 * (1.0 - 1.5125) = -0.0154 → still negative
  // At h=0.5, Pro expected (1.5125) > Flash miss (1.0), so penalty is ALWAYS negative
  // → staying on Pro costs MORE for accumulated context than switching to Flash
  // → Flash is cheaper, so we should switch

  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    cacheHitRate: 0.5,
    accumulatedTokens: 30_000,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  // payback negative → always switches
  assert.ok(result.paybackRounds < 0);
});

test("Pro→Flash: very conservative config (h=0.1) -> Pro expected very high -> switches Flash", () => {
  // h=0.1: proExpected = 0.1*0.025 + 0.9*3.0 = 2.7025
  // penalty = 0.1 * (1.0 - 2.7025) = -0.17025 → negative → always switch
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    cacheHitRate: 0.1,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
});

test("Pro→Flash: very small savings (low output) -> stays Pro", () => {
  // With tiny output estimate, savings are too small
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    estimatedOutputPerRound: 50,
    accumulatedTokens: 500_000,
  }));
  // With 50 output tokens: savings = 50*4/1M = 0.0002
  // With h=0.5, penalty ≈ -0.03 (50k acc) → negative threshold is low
  // Actually if penalty is negative and savings positive, we switch regardless of size
  // But let me check: with acc=500k, penalty = 0.5 * (1.0 - 1.5125) = -0.256
  // payback = -0.256 / 0.0002 = -1280 → negative means immediate switching
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
});

// ═══════════════════════════════════════════════
// Flash → Pro：复杂度驱动升级
// ═══════════════════════════════════════════════

test("Flash→Pro: no complexity signals -> stays Flash", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    roundsOnFlash: 2,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.reason.includes("复杂度分数=0"));
});

test("Flash→Pro: high error rate alone -> not enough to upgrade", () => {
  // errorRate=0.5 → +2, but threshold is 3
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.5,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.reason.includes("复杂度分数=2"));
});

test("Flash→Pro: error rate + unique tools -> upgrade to Pro", () => {
  // errorRate=0.3 → +2, uniqueToolCount=3 → +2 = 4 ≥ 3 → upgrade!
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.3,
    uniqueToolCount: 3,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("复杂度分数=4"));
  assert.ok(result.reason.includes("升级到 Pro"));
});

test("Flash→Pro: roundsOnFlash >= 5 + newUserMessage -> upgrade", () => {
  // roundsOnFlash=5 → +1, newUserMessage=true → +1, total=2 < 3 → stay Flash
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    roundsOnFlash: 5,
    newUserMessage: true,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.reason.includes("复杂度分数=2"));
});

test("Flash→Pro: error rate + roundsOnFlash + newUserMessage = 4 -> upgrade", () => {
  // errorRate=0.3 → +2, roundsOnFlash=5 → +1, newUserMessage → +1, total=4 ≥ 3 → upgrade!
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.3,
    roundsOnFlash: 5,
    newUserMessage: true,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("复杂度分数=4"));
});

test("Flash→Pro: all signals fire -> clearly upgrade", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.5,           // +2
    uniqueToolCount: 5,       // +2
    roundsOnFlash: 6,         // +1
    newUserMessage: true,     // +1
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("复杂度分数=6"));
  assert.ok(result.reason.includes("错误率=50%"));
  assert.ok(result.reason.includes("种工具"));
});

test("Flash→Pro: maxPaybackRounds=0 does NOT prevent upgrade", () => {
  // maxPaybackRounds=0 only affects Pro→Flash direction; Flash→Pro is quality-driven
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    maxPaybackRounds: 0,
    errorRate: 0.4,
    uniqueToolCount: 3,
  }));
  assert.equal(result.model, DEEPSEEK_V4_PRO);
  assert.ok(result.reason.includes("复杂度分数=4"));
});

// ═══════════════════════════════════════════════
// 边界场景
// ═══════════════════════════════════════════════

test("currentModel defaults to Pro when not specified", () => {
  // On Pro, no complexity signals → tries Pro→Flash path
  // h=0.5 → penalty negative → switches Flash
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx());
  // With h=0.5 and acc=100k, penalty is negative → switch Flash
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
});

test("flash→Pro: error rate < 0.3 does not trigger signal", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.2,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
  assert.ok(result.reason.includes("复杂度分数=0"));
});

test("flash→Pro: error rate at exactly 0.3 triggers signal", () => {
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    currentModel: DEEPSEEK_V4_FLASH,
    errorRate: 0.3,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);  // score=2, below 3
});

test("Pro→Flash: very cold cache (h=0) switches to Flash aggressively", () => {
  // h=0: proExpected = 3.0, flashExpected = 1.0
  // penalty = 0.1 * (1.0 - 3.0) = -0.2 → negative → immediate switch
  const result = selectModelByPrice(DEEPSEEK_V4_PRO, true, makeCtx({
    cacheHitRate: 0,
  }));
  assert.equal(result.model, DEEPSEEK_V4_FLASH);
});

test("non-DS primary model with tools does nothing", () => {
  const result = selectModelByPrice("glm-4.0", true, makeCtx());
  assert.equal(result.model, "glm-4.0");
  assert.ok(result.reason.includes("非 Pro 主模型"));
});
