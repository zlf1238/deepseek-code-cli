export const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH = "deepseek-v4-flash";
export const DEEPSEEK_V4_MODELS = new Set([DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO]);

// DeepSeek v4 公开定价（元/每百万 tokens）
export const DEEPSEEK_V4_PRO_PRICING: PricingSnapshot = {
  inputCacheHitPricePerMillion:  0.025,
  inputCacheMissPricePerMillion: 3.0,
  outputPricePerMillion:         6.0,
};
export const DEEPSEEK_V4_FLASH_PRICING: PricingSnapshot = {
  inputCacheHitPricePerMillion:  0.02,
  inputCacheMissPricePerMillion: 1.0,
  outputPricePerMillion:         2.0,
};

export function defaultsToThinkingMode(model: string): boolean {
  // 仅 pro 模型默认启用思考模式；flash 追求速度和低成本
  return model === DEEPSEEK_V4_PRO;
}

const DEEPSEEK_V4_CONTEXT_WINDOW = 1024 * 1024;   // 1M tokens
const DEFAULT_CONTEXT_WINDOW = 128 * 1024;          // 128K tokens

export function getContextWindowCapacity(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_CONTEXT_WINDOW
    : DEFAULT_CONTEXT_WINDOW;
}

/** 每个模型的定价快照（每百万 token 计费）。 */
export type PricingSnapshot = {
  inputCacheHitPricePerMillion: number;
  inputCacheMissPricePerMillion: number;
  outputPricePerMillion: number;
};

/**
 * 模型选择策略：主循环不做 Pro↔Flash 切换，统一使用当前模型。
 *
 * 设计决策：
 *   实际数据表明，任何主循环内的模型切换都会污染 Pro 的 prefix-cache，
 *   使命中率从 0.95 降至 0.50，input 成本反而更高。
 *
 *   selectModelByPrice 保留为 no-op：始终返回 primaryModel，不做切换。
 */
export function selectModelByPrice(
  primaryModel: string,
  _hadToolCalls: boolean,
  _ctx: Record<string, unknown>,
): { model: string; reason: string; paybackRounds: number } {
  return {
    model: primaryModel,
    reason: "主循环固定模型，不做切换",
    paybackRounds: NaN,
  };
}

/** 模型选择下拉菜单中显示的简短提供商标签。 */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
