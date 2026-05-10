export const DEEPSEEK_V4_PRO = "deepseek-v4-pro";
export const DEEPSEEK_V4_FLASH = "deepseek-v4-flash";
export const DEEPSEEK_V4_MODELS = new Set([DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO]);

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

/**
 * 根据当前迭代上下文选择合适的模型。
 * - 首次调用（无工具调用历史）：使用 pro 进行分析/规划
 * - 已有工具调用（文件修改后）：使用 flash 追求速度/成本
 * - 若首选模型不可用则回退到 primaryModel
 * @deprecated 请使用 selectModelByPrice 实现价格感知切换
 */
export function selectModelForIteration(
  primaryModel: string,
  hadToolCalls: boolean
): string {
  // 仅在以 DeepSeek v4 pro 为主模型时才进行优化
  if (primaryModel !== DEEPSEEK_V4_PRO || !hadToolCalls) {
    return primaryModel;
  }

  // 工具调用后，优先使用 flash 处理文件修改
  return DEEPSEEK_V4_FLASH;
}

/** 每个模型的定价快照（每百万 token 计费）。 */
export type PricingSnapshot = {
  inputCacheHitPricePerMillion: number;
  inputCacheMissPricePerMillion: number;
  outputPricePerMillion: number;
};

/** 每次切换决策时传递给 selectModelByPrice 的上下文。 */
export type SwitchContext = {
  /** 是否启用自动切换。设为 false 时始终保持主模型。 */
  enabled: boolean;
  proPricing: PricingSnapshot;
  flashPricing: PricingSnapshot;
  /** 目前为止会话中累积的总 token 数（近似前缀长度）。 */
  accumulatedTokens: number;
  /** 最近一次工具调用的名称（如 "AskUserQuestion"），未调用则 undefined。 */
  lastToolName?: string;
  /** 切换代价需在多少轮内回本。 */
  maxPaybackRounds: number;
  /** 每轮预估的 output token 数。 */
  estimatedOutputPerRound: number;
};

export type SwitchResult = {
  model: string;
  /** 决策理由（人类可读）。 */
  reason: string;
  /** 计算得出的回本轮数（不适用时为 NaN）。 */
  paybackRounds: number;
};

/**
 * 基于回本轮数方法的价格感知模型选择。
 *
 * 若 Pro 在全部三个维度（cacheHit、cacheMiss、output）都更便宜或持平，
 * 绝不切换到 Flash——留在 Pro 是严格最优的。
 *
 * 否则计算切换代价和每轮节省：
 *   switchPenalty = accumulatedTokens/1M * (flash.cacheMiss - pro.cacheHit)
 *   roundSaving   = outputEst/1M * (pro.output - flash.output)
 *   paybackRounds = switchPenalty / roundSaving
 *
 * 仅当 paybackRounds <= maxPaybackRounds 时才切换到 Flash。
 * AskUserQuestion 工具调用始终锁定 Pro（用户交互质量至关重要）。
 */
export function selectModelByPrice(
  primaryModel: string,
  hadToolCalls: boolean,
  ctx: SwitchContext
): SwitchResult {
  // 配置中关闭自动切换时，跳过价格感知逻辑
  if (!ctx.enabled) {
    return { model: primaryModel, reason: "自动切换已禁用", paybackRounds: NaN };
  }

  const neverSwitch = {
    model: primaryModel,
    reason: "尚无工具调用——保持主模型",
    paybackRounds: NaN
  };

  // 仅当主模型为 Pro 且有工具调用历史时才考虑切换
  if (primaryModel !== DEEPSEEK_V4_PRO || !hadToolCalls) {
    return neverSwitch;
  }

  const { proPricing: pp, flashPricing: fp } = ctx;

  // P3: AskUserQuestion 锁定 Pro——用户交互质量至关重要
  if (ctx.lastToolName === "AskUserQuestion") {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: "检测到 AskUserQuestion——锁定 Pro 以保证交互质量",
      paybackRounds: NaN
    };
  }

  // 检查 Pro 是否在全部维度都不比 Flash 贵
  const proCheaperHit = pp.inputCacheHitPricePerMillion <= fp.inputCacheHitPricePerMillion;
  const proCheaperMiss = pp.inputCacheMissPricePerMillion <= fp.inputCacheMissPricePerMillion;
  const proCheaperOut = pp.outputPricePerMillion <= fp.outputPricePerMillion;

  if (proCheaperHit && proCheaperMiss && proCheaperOut) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: "Pro 在全部维度更便宜——绝不切换到 Flash",
      paybackRounds: NaN
    };
  }

  // 计算切换代价和每轮节省
  const switchPenalty = ctx.accumulatedTokens / 1_000_000 * (fp.inputCacheMissPricePerMillion - pp.inputCacheHitPricePerMillion);
  const roundSaving = ctx.estimatedOutputPerRound / 1_000_000 * (pp.outputPricePerMillion - fp.outputPricePerMillion);

  if (roundSaving <= 0) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: `Flash 输出价格更高（节省=${roundSaving.toFixed(4)}）——留在 Pro`,
      paybackRounds: Infinity
    };
  }

  const paybackRounds = switchPenalty / roundSaving;

  if (paybackRounds <= ctx.maxPaybackRounds) {
    return {
      model: DEEPSEEK_V4_FLASH,
      reason: `${paybackRounds.toFixed(1)} 轮回本（≤${ctx.maxPaybackRounds}）——切换到 Flash`,
      paybackRounds
    };
  }

  return {
    model: DEEPSEEK_V4_PRO,
    reason: `${paybackRounds.toFixed(1)} 轮回本（>${ctx.maxPaybackRounds}）——留在 Pro`,
    paybackRounds
  };
}

/** 模型选择下拉菜单中显示的简短提供商标签。 */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
