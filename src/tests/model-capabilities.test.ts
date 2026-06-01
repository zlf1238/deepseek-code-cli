import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_V4_PRO,
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO_PRICING,
  DEEPSEEK_V4_FLASH_PRICING,
  getContextWindowCapacity,
  defaultsToThinkingMode,
} from "../model-capabilities";

// ═══════════════════════════════════════════════
// 定价数据
// ═══════════════════════════════════════════════

test("Pro pricing is 3× Flash on output", () => {
  assert.equal(DEEPSEEK_V4_PRO_PRICING.outputPricePerMillion, 6.0);
  assert.equal(DEEPSEEK_V4_FLASH_PRICING.outputPricePerMillion, 2.0);
});

test("Flash cache-miss input is 1/3 of Pro", () => {
  assert.equal(DEEPSEEK_V4_FLASH_PRICING.inputCacheMissPricePerMillion, 1.0);
  assert.equal(DEEPSEEK_V4_PRO_PRICING.inputCacheMissPricePerMillion, 3.0);
});

// ═══════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════

test("getContextWindowCapacity returns 1M for v4 models", () => {
  assert.equal(getContextWindowCapacity(DEEPSEEK_V4_PRO), 1024 * 1024);
  assert.equal(getContextWindowCapacity(DEEPSEEK_V4_FLASH), 1024 * 1024);
});

test("getContextWindowCapacity returns 128K for unknown models", () => {
  assert.equal(getContextWindowCapacity("unknown-model"), 128 * 1024);
});

test("defaultsToThinkingMode: Pro=true, Flash=false", () => {
  assert.equal(defaultsToThinkingMode(DEEPSEEK_V4_PRO), true);
  assert.equal(defaultsToThinkingMode(DEEPSEEK_V4_FLASH), false);
});
