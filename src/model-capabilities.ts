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
 * Supervisor-Worker 架构：Pro 固定主循环（热缓存），Flash 子智能体做代码修改。
 *
 * 设计决策（2025-07）：
 *   主循环不再做 Pro↔Flash 模型切换。实测数据表明，任何主循环内的 Flash 切换
 *   都会污染 Pro 的 prefix-cache，使命中率从 0.95 降至 0.50，input 成本反而
 *   更高（200K 上下文时单次请求 input 成本 ¥0.30 vs ¥0.03）。
 *
 *   代码修改的 output 成本节省（¥6→¥2/M）委托给 spawn_code_executor 子智能体，
 *   它运行在隔离的上下文中，不影响主循环缓存。
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
    reason: "Supervisor-Worker 架构 —— 主循环固定 Pro，修改委派子智能体",
    paybackRounds: NaN,
  };
}

/** 模型选择下拉菜单中显示的简短提供商标签。 */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
