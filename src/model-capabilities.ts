export const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH = "deepseek-v4-flash";
export const DEEPSEEK_V4_MODELS = new Set([DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO]);

export function defaultsToThinkingMode(model: string): boolean {
  // Only pro model enables thinking by default; flash is fast/cheap
  return model === DEEPSEEK_V4_PRO;
}

const DEEPSEEK_V4_CONTEXT_WINDOW = 1024 * 1024;   // 1M tokens
const DEFAULT_CONTEXT_WINDOW = 128 * 1024;          // 128K tokens

export function getContextWindowCapacity(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Select the appropriate model based on the current iteration context.
 * - First call (no prior tool calls): use pro for analysis/planning
 * - After tool calls (file modifications): use flash for speed/cost
 * - Falls back to primaryModel if the preferred model is not available
 * @deprecated Use selectModelByPrice instead for price-aware switching
 */
export function selectModelForIteration(
  primaryModel: string,
  hadToolCalls: boolean
): string {
  // Only optimize when using DeepSeek v4 pro as primary
  if (primaryModel !== DEEPSEEK_V4_PRO || !hadToolCalls) {
    return primaryModel;
  }

  // After tool calls, prefer flash for file modifications
  return DEEPSEEK_V4_FLASH;
}

/** Per-model pricing snapshot (per million tokens). */
export type PricingSnapshot = {
  inputCacheHitPricePerMillion: number;
  inputCacheMissPricePerMillion: number;
  outputPricePerMillion: number;
};

/** Context passed to selectModelByPrice for each switching decision. */
export type SwitchContext = {
  proPricing: PricingSnapshot;
  flashPricing: PricingSnapshot;
  /** Total tokens accumulated in this session so far (approximates prefix length). */
  accumulatedTokens: number;
  /** Name of the last tool called (e.g. "AskUserQuestion"), or undefined. */
  lastToolName?: string;
  /** Max rounds the switch penalty must be paid back within. */
  maxPaybackRounds: number;
  /** Estimated output tokens per round. */
  estimatedOutputPerRound: number;
};

export type SwitchResult = {
  model: string;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Calculated payback rounds (NaN if not applicable). */
  paybackRounds: number;
};

/**
 * Price-aware model selection using payback-rounds method.
 *
 * If Pro is cheaper or equal in ALL three dimensions (cacheHit, cacheMiss, output),
 * never switch to Flash — staying on Pro is strictly optimal.
 *
 * Otherwise, compute the switching penalty and per-round savings:
 *   switchPenalty = accumulatedTokens/1M * (flash.cacheMiss - pro.cacheHit)
 *   roundSaving   = outputEst/1M * (pro.output - flash.output)
 *   paybackRounds = switchPenalty / roundSaving
 *
 * Switch to Flash only when paybackRounds <= maxPaybackRounds.
 * AskUserQuestion tool calls always lock to Pro (user interaction quality matters).
 */
export function selectModelByPrice(
  primaryModel: string,
  hadToolCalls: boolean,
  ctx: SwitchContext
): SwitchResult {
  const neverSwitch = {
    model: primaryModel,
    reason: "No tool calls yet — keep primary model",
    paybackRounds: NaN
  };

  // Only consider switching when primary is Pro and there were tool calls
  if (primaryModel !== DEEPSEEK_V4_PRO || !hadToolCalls) {
    return neverSwitch;
  }

  const { proPricing: pp, flashPricing: fp } = ctx;

  // P3: AskUserQuestion locks Pro — user interaction quality matters
  if (ctx.lastToolName === "AskUserQuestion") {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: "AskUserQuestion detected — locked to Pro for quality",
      paybackRounds: NaN
    };
  }

  // Check if Pro is cheaper or equal in ALL dimensions
  const proCheaperHit = pp.inputCacheHitPricePerMillion <= fp.inputCacheHitPricePerMillion;
  const proCheaperMiss = pp.inputCacheMissPricePerMillion <= fp.inputCacheMissPricePerMillion;
  const proCheaperOut = pp.outputPricePerMillion <= fp.outputPricePerMillion;

  if (proCheaperHit && proCheaperMiss && proCheaperOut) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: "Pro is cheaper in all dimensions — never switch to Flash",
      paybackRounds: NaN
    };
  }

  // Compute switching penalty and per-round savings
  const switchPenalty = ctx.accumulatedTokens / 1_000_000 * (fp.inputCacheMissPricePerMillion - pp.inputCacheHitPricePerMillion);
  const roundSaving = ctx.estimatedOutputPerRound / 1_000_000 * (pp.outputPricePerMillion - fp.outputPricePerMillion);

  if (roundSaving <= 0) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: `Flash output not cheaper (saving=${roundSaving.toFixed(4)}) — stay on Pro`,
      paybackRounds: Infinity
    };
  }

  const paybackRounds = switchPenalty / roundSaving;

  if (paybackRounds <= ctx.maxPaybackRounds) {
    return {
      model: DEEPSEEK_V4_FLASH,
      reason: `Payback in ${paybackRounds.toFixed(1)} rounds (≤${ctx.maxPaybackRounds}) — switch to Flash`,
      paybackRounds
    };
  }

  return {
    model: DEEPSEEK_V4_PRO,
    reason: `Payback ${paybackRounds.toFixed(1)} rounds (>${ctx.maxPaybackRounds}) — stay on Pro`,
    paybackRounds
  };
}

/** Short provider tag shown in the model picker dropdown. */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
