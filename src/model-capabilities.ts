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
  // ── 缓存感知扩展 ──
  /** 每轮预估 new input token 数（默认 500），参与 input 侧节省计算。 */
  estimatedInputPerRound: number;
  /** 缓存命中率 0-1（默认 0.5），影响预期输入价格。 */
  cacheHitRate: number;
  // ── 双向切换扩展 ──
  /** 当前正在使用的模型，用于判断切换方向。默认等于 primaryModel。 */
  currentModel?: string;
  // ── 复杂度信号（Flash → Pro 方向）──
  /** Flash 已连续运行轮数。 */
  roundsOnFlash?: number;
  /** 工具调用失败率 0-1（如无数据则为 undefined）。 */
  errorRate?: number;
  /** 本会话使用过的不同工具类型数。 */
  uniqueToolCount?: number;
  /** 本轮是否是用户新消息（非工具调用循环的后续轮次）。 */
  newUserMessage?: boolean;
};

export type SwitchResult = {
  model: string;
  /** 决策理由（人类可读）。 */
  reason: string;
  /** 计算得出的回本轮数（不适用时为 NaN）。 */
  paybackRounds: number;
};

// ── 内部辅助：计算预期输入价格 ──

function expectedInputPrice(p: PricingSnapshot, cacheHitRate: number): number {
  return cacheHitRate * p.inputCacheHitPricePerMillion
       + (1 - cacheHitRate) * p.inputCacheMissPricePerMillion;
}

// ── 内部辅助：Pro → Flash 方向 ──

function decideProToFlash(ctx: SwitchContext): SwitchResult {
  const pp = ctx.proPricing;
  const fp = ctx.flashPricing;
  const h = ctx.cacheHitRate;

  const proExpectedInput = expectedInputPrice(pp, h);
  const flashExpectedInput = expectedInputPrice(fp, h);

  // 切换惩罚：累积上下文在 Flash 上冷启动（miss 价）vs 在 Pro 上已预热（expected 价）
  const switchPenalty = ctx.accumulatedTokens / 1_000_000
    * (fp.inputCacheMissPricePerMillion - proExpectedInput);

  // 每轮节省：output 价差 + new input 价差
  const outputSaving = ctx.estimatedOutputPerRound / 1_000_000
    * (pp.outputPricePerMillion - fp.outputPricePerMillion);
  const inputSaving = ctx.estimatedInputPerRound / 1_000_000
    * (proExpectedInput - flashExpectedInput);
  const roundSaving = outputSaving + inputSaving;

  if (roundSaving <= 0) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: `Flash 无单轮成本优势（节省=${roundSaving.toFixed(6)}）——留在 Pro`,
      paybackRounds: Infinity
    };
  }

  const paybackRounds = switchPenalty / roundSaving;

  if (paybackRounds <= ctx.maxPaybackRounds) {
    return {
      model: DEEPSEEK_V4_FLASH,
      reason: `${paybackRounds.toFixed(1)} 轮回本（≤${ctx.maxPaybackRounds}，h=${h.toFixed(2)}）——切换到 Flash`,
      paybackRounds
    };
  }

  return {
    model: DEEPSEEK_V4_PRO,
    reason: `${paybackRounds.toFixed(1)} 轮回本（>${ctx.maxPaybackRounds}，h=${h.toFixed(2)}）——留在 Pro`,
    paybackRounds
  };
}

// ── 内部辅助：Flash → Pro 方向（复杂度驱动）──

/** 复杂度分数达到此阈值时触发 Flash → Pro 升级。 */
const PRO_UPGRADE_COMPLEXITY_THRESHOLD = 3;

function decideFlashToPro(ctx: SwitchContext): SwitchResult {
  let score = 0;
  const signals: string[] = [];

  // 信号 1：工具调用频繁失败——Flash 可能跟不上
  if (ctx.errorRate !== undefined && ctx.errorRate >= 0.3) {
    score += 2;
    signals.push(`错误率=${(ctx.errorRate * 100).toFixed(0)}%`);
  }

  // 信号 2：多工具协同——任务不简单
  if (ctx.uniqueToolCount !== undefined && ctx.uniqueToolCount >= 3) {
    score += 2;
    signals.push(`${ctx.uniqueToolCount}种工具`);
  }

  // 信号 3：Flash 连续运行多轮——任务可能超出简单范畴
  if (ctx.roundsOnFlash !== undefined && ctx.roundsOnFlash >= 5) {
    score += 1;
    signals.push(`Flash已运行${ctx.roundsOnFlash}轮`);
  }

  // 信号 4：用户新消息——需要重新规划
  if (ctx.newUserMessage) {
    score += 1;
    signals.push("用户新消息");
  }

  if (score >= PRO_UPGRADE_COMPLEXITY_THRESHOLD) {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: `复杂度分数=${score}（≥${PRO_UPGRADE_COMPLEXITY_THRESHOLD}，${signals.join(", ")}）——升级到 Pro`,
      paybackRounds: NaN
    };
  }

  return {
    model: DEEPSEEK_V4_FLASH,
    reason: `复杂度分数=${score}（<${PRO_UPGRADE_COMPLEXITY_THRESHOLD}）——留在 Flash`,
    paybackRounds: NaN
  };
}

// ── 对外入口：双向预期成本切换 ──

/**
 * 缓存感知的双向模型切换决策。
 *
 * 首次调用（无工具调用）→ 保持当前模型（默认 Pro 规划阶段）。
 * AskUserQuestion 锁定 Pro（用户交互质量至关重要）。
 *
 * Pro → Flash 方向：基于预期成本（含缓存命中率 + input/output 双通道节省）的回本计算。
 * Flash → Pro 方向：基于复杂度评分（错误率、工具多样性、运行轮数、新用户消息）。
 *
 * maxPaybackRounds=0 可禁止 Pro→Flash 切换（Flash→Pro 升级不受影响）。
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

  // 仅当主模型为 Pro 时才进行优化
  if (primaryModel !== DEEPSEEK_V4_PRO) {
    return { model: primaryModel, reason: "非 Pro 主模型，不切换", paybackRounds: NaN };
  }

  // 规划阶段：无工具调用时保持当前模型
  if (!hadToolCalls) {
    const current = ctx.currentModel ?? primaryModel;
    return { model: current, reason: "规划阶段——保持当前模型", paybackRounds: NaN };
  }

  // AskUserQuestion 锁定 Pro
  if (ctx.lastToolName === "AskUserQuestion") {
    return {
      model: DEEPSEEK_V4_PRO,
      reason: "检测到 AskUserQuestion——锁定 Pro 以保证交互质量",
      paybackRounds: NaN
    };
  }

  const currentModel = ctx.currentModel ?? primaryModel;

  if (currentModel === DEEPSEEK_V4_FLASH) {
    // Flash → Pro：复杂度驱动
    return decideFlashToPro(ctx);
  }

  // Pro → Flash：成本驱动
  if (ctx.maxPaybackRounds === 0) {
    return { model: DEEPSEEK_V4_PRO, reason: "maxPaybackRounds=0——禁止自动切换", paybackRounds: NaN };
  }

  return decideProToFlash(ctx);
}

/** 模型选择下拉菜单中显示的简短提供商标签。 */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
