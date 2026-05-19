import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { defaultsToThinkingMode, DEEPSEEK_V4_PRO, DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO_PRICING, DEEPSEEK_V4_FLASH_PRICING } from "./model-capabilities";
import type { PricingSnapshot } from "./model-capabilities";

export type DeepcodingEnv = {
  MODEL?: string;
  BASE_URL?: string;
  API_KEY?: string;
  THINKING?: string;
};

export type ReasoningEffort = "high" | "max";

export type ModelOverride = {
  baseURL?: string;
  apiKey?: string;
  pricing?: PricingConfig;
};

export type PricingConfig = {
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** 缓存命中的输入价格（每百万 token），如未设置则使用 inputPricePerMillion */
  inputCacheHitPricePerMillion?: number;
  /** 缓存未命中的输入价格（每百万 token），如未设置则使用 inputPricePerMillion */
  inputCacheMissPricePerMillion?: number;
};

export type AutoSwitchConfig = {
  /** 是否启用价格感知模型自动切换（默认 true） */
  enabled?: boolean;
  /** 最大回本轮数（默认 8），设置为 0 可禁止切换到 Flash（需 enabled=true） */
  maxPaybackRounds?: number;
  /** 预估每轮 output token 数（默认 8000），用于计算 roundSaving */
  estimatedOutputPerRound?: number;
  /** 预估每轮 new input token 数（默认 500），用于计算 input 侧节省 */
  estimatedInputPerRound?: number;
  /** 缓存命中率估算 0-1（默认 0.5），长会话建议 0.8+；影响预期输入价格计算 */
  cacheHitRate?: number;
};

export type RTKSettings = {
  /** 是否启用 RTK 输出压缩（默认 false） */
  enabled?: boolean;
  /** RTK 二进制路径（默认 "rtk"） */
  binaryPath?: string;
  /** 跳过 RTK 包装的命令前缀列表（追加到内置默认列表之上） */
  exclude?: string[];
};

/** 模型使用模式：pro = 仅用 Pro，flash = 仅用 Flash，auto = 双向自动切换。 */
export type ModelMode = "pro" | "flash" | "auto";

export type GitnexusConfig = {
  /** 是否启用 GitNexus 知识图谱集成（默认 true） */
  enabled?: boolean;
  /** 会话启动时自动索引（默认 true） */
  autoIndex?: boolean;
  /** 索引过期时间（分钟），默认 30 */
  maxIndexAgeMinutes?: number;
};

export type DeepcodingSettings = {
  /** 模型模式，优先级高于 env.MODEL + autoSwitch 组合配置。 */
  mode?: ModelMode;
  env?: DeepcodingEnv;
  models?: Record<string, ModelOverride>;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** 是否展示详细模式：包括思考过程（reasoning_content）和所有工具调用历史。 */
  verboseMode?: boolean;
  notify?: string;
  webSearchTool?: string;
  pricing?: PricingConfig;
  autoSwitch?: AutoSwitchConfig;
  rtk?: RTKSettings;
  gitnexus?: GitnexusConfig;
};

export type ResolvedAutoSwitchConfig = {
  enabled: boolean;
  maxPaybackRounds: number;
  estimatedOutputPerRound: number;
  estimatedInputPerRound: number;
  cacheHitRate: number;
};

export type ResolvedDeepcodingSettings = {
  apiKey?: string;
  baseURL: string;
  model: string;
  mode: ModelMode;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  notify?: string;
  webSearchTool?: string;
  pricing: Required<PricingConfig>;
  autoSwitch: ResolvedAutoSwitchConfig;
};

function resolveReasoningEffort(value: unknown): ReasoningEffort {
  return value === "high" || value === "max" ? value : "max";
}

function resolveAutoSwitchConfig(settings: DeepcodingSettings | null | undefined): ResolvedAutoSwitchConfig {
  const raw = settings?.autoSwitch;
  // enabled 默认为 true；显式设为 false 则完全禁用自动切换
  const enabled = raw?.enabled !== false;
  // maxPaybackRounds=0 表示"不切换"（需 enabled=true）；<0 或未提供则默认 8
  const maxPaybackRounds = (typeof raw?.maxPaybackRounds === "number" && raw.maxPaybackRounds >= 0)
    ? raw.maxPaybackRounds : 8;
  // Flash 自动切换时启用思考模式，output token 介于纯 Flash 和 Pro 之间，默认 8000
  const estimatedOutputPerRound = (typeof raw?.estimatedOutputPerRound === "number" && raw.estimatedOutputPerRound > 0)
    ? raw.estimatedOutputPerRound : 8000;
  // 每轮新增 input token 估算，默认 500
  const estimatedInputPerRound = (typeof raw?.estimatedInputPerRound === "number" && raw.estimatedInputPerRound > 0)
    ? raw.estimatedInputPerRound : 500;
  // 缓存命中率 0-1，默认保守估计 0.5；长会话可上调至 0.8+
  const cacheHitRate = (typeof raw?.cacheHitRate === "number" && raw.cacheHitRate >= 0 && raw.cacheHitRate <= 1)
    ? raw.cacheHitRate : 0.5;
  return { enabled, maxPaybackRounds, estimatedOutputPerRound, estimatedInputPerRound, cacheHitRate };
}

/**
 * 从 settings 中解析 mode 字段。
 * - 未设置或无效值 → "auto"（保持现有行为）
 */
function resolveMode(settings: DeepcodingSettings | null | undefined): ModelMode {
  const mode = settings?.mode;
  if (mode === "pro" || mode === "flash") return mode;
  return "auto";
}

/**
 * 根据 mode 覆写 ResolvedDeepcodingSettings 中的 model 和 autoSwitch。
 *
 * ┌──────────┬────────────────┬─────────────────────────────────┐
 * │ mode     │ 实际 model     │ autoSwitch.enabled               │
 * ├──────────┼────────────────┼─────────────────────────────────┤
 * │ "pro"    │ deepseek-v4-pro│ false（永不切到 Flash）          │
 * │ "flash"  │ deepseek-v4-flash│ false（永不用 Pro）            │
 * │ "auto"   │ 保持解析结果    │ 保持原有值（默认 true）          │
 * │ "auto" + │ 保持 Flash      │ false（用户选了 Flash 就不切）  │
 * │   MODEL=flash │           │                                 │
 * └──────────┴────────────────┴─────────────────────────────────┘
 */
function applyModeOverrides(resolved: ResolvedDeepcodingSettings): ResolvedDeepcodingSettings {
  const { model, autoSwitch, mode } = resolved;

  switch (mode) {
    case "pro":
      return {
        ...resolved,
        model: DEEPSEEK_V4_PRO,
        autoSwitch: { ...autoSwitch, enabled: false },
      };
    case "flash":
      return {
        ...resolved,
        model: DEEPSEEK_V4_FLASH,
        autoSwitch: { ...autoSwitch, enabled: false },
      };
    case "auto":
    default:
      // 用户显式将 env.MODEL 设为 Flash 时，保持不切换回 Pro
      if (model === DEEPSEEK_V4_FLASH) {
        return { ...resolved, autoSwitch: { ...autoSwitch, enabled: false } };
      }
      return resolved;
  }
}

function resolveThinkingEnabled(
  settings: DeepcodingSettings | null | undefined,
  model: string
): boolean {
  if (typeof settings?.thinkingEnabled === "boolean") {
    return settings.thinkingEnabled;
  }

  const legacyThinking = settings?.env?.THINKING;
  if (typeof legacyThinking === "string" && legacyThinking.trim()) {
    return legacyThinking.trim().toLowerCase() === "enabled";
  }

  return defaultsToThinkingMode(model);
}

export function resolveSettings(
  settings: DeepcodingSettings | null | undefined,
  defaults: { model: string; baseURL: string }
): ResolvedDeepcodingSettings {
  const env = settings?.env ?? {};
  const model = env.MODEL?.trim() || defaults.model;
  const notify = typeof settings?.notify === "string" ? settings.notify.trim() : "";
  const webSearchTool =
    typeof settings?.webSearchTool === "string" ? settings.webSearchTool.trim() : "";

  // Merge per-model overrides from settings.models
  const modelOverride = isRecord(settings?.models)
    ? (settings!.models as Record<string, ModelOverride>)[model]
    : undefined;
  const resolvedApiKey = modelOverride?.apiKey?.trim() || env.API_KEY?.trim();
  const resolvedBaseURL =
    modelOverride?.baseURL?.trim() || env.BASE_URL?.trim() || defaults.baseURL;

  // 内置市场基准定价 fallback：用户可在 settings.json 中覆盖
  const defaultPricing: PricingSnapshot | null =
    model === DEEPSEEK_V4_PRO ? DEEPSEEK_V4_PRO_PRICING
    : model === DEEPSEEK_V4_FLASH ? DEEPSEEK_V4_FLASH_PRICING
    : null;

  const resolvePrice = (field: "inputPricePerMillion" | "outputPricePerMillion"): number => {
    // 1. 优先使用 per-model 定价
    const modelPrice = modelOverride?.pricing?.[field];
    if (typeof modelPrice === "number" && !Number.isNaN(modelPrice)) {
      return modelPrice;
    }
    // 2. 其次使用全局定价
    const globalPrice = settings?.pricing?.[field];
    if (typeof globalPrice === "number" && !Number.isNaN(globalPrice)) {
      return globalPrice;
    }
    // 3. 已知模型使用内置市场基准价（如 deepseek-v4-pro/flash）
    if (defaultPricing) {
      if (field === "inputPricePerMillion") return defaultPricing.inputCacheMissPricePerMillion;
      if (field === "outputPricePerMillion") return defaultPricing.outputPricePerMillion;
    }
    // 4. 未知模型默认 0
    return 0;
  };

  const resolveCachePrice = (field: "inputCacheHitPricePerMillion" | "inputCacheMissPricePerMillion"): number => {
    // 1. 优先使用 per-model 定价
    const modelPrice = modelOverride?.pricing?.[field];
    if (typeof modelPrice === "number" && !Number.isNaN(modelPrice)) {
      return modelPrice;
    }
    // 2. 其次使用全局定价
    const globalPrice = settings?.pricing?.[field];
    if (typeof globalPrice === "number" && !Number.isNaN(globalPrice)) {
      return globalPrice;
    }
    // 3. 已知模型使用内置市场基准价（如 deepseek-v4-pro/flash）
    if (defaultPricing) {
      return defaultPricing[field];
    }
    // 4. 未知模型默认 0
    return 0;
  };

  const pricing: Required<PricingConfig> = {
    inputPricePerMillion: resolvePrice("inputPricePerMillion"),
    outputPricePerMillion: resolvePrice("outputPricePerMillion"),
    inputCacheHitPricePerMillion: resolveCachePrice("inputCacheHitPricePerMillion"),
    inputCacheMissPricePerMillion: resolveCachePrice("inputCacheMissPricePerMillion"),
  };

  return applyModeOverrides({
    apiKey: resolvedApiKey,
    baseURL: resolvedBaseURL,
    model,
    mode: resolveMode(settings),
    thinkingEnabled: resolveThinkingEnabled(settings, model),
    reasoningEffort: resolveReasoningEffort(settings?.reasoningEffort),
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    pricing,
    autoSwitch: resolveAutoSwitchConfig(settings)
  });
}

/** 返回 settings 中声明的所有模型名称（env.MODEL + models keys），去重后排序。 */
export function getAvailableModelNames(settings: DeepcodingSettings | null | undefined): string[] {
  const names = new Set<string>();

  const envModel = settings?.env?.MODEL?.trim();
  if (envModel) {
    names.add(envModel);
  }

  if (settings?.models && typeof settings.models === "object") {
    for (const key of Object.keys(settings.models)) {
      if (key.trim()) {
        names.add(key.trim());
      }
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * 将当前激活的模型名称持久化到 settings.json（通过更新 env.MODEL）。
 * 成功返回 true，失败返回 false。
 */
export function updateActiveModelInSettings(modelName: string): boolean {
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as DeepcodingSettings;

    settings.env = settings.env ?? {};
    settings.env.MODEL = modelName;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 thinkingEnabled 和 reasoningEffort 持久化到 settings.json。
 * 成功返回 true，失败返回 false。
 */
export function updateThinkingConfigInSettings(
  thinkingEnabled: boolean,
  reasoningEffort?: ReasoningEffort
): boolean {
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as DeepcodingSettings;

    settings.thinkingEnabled = thinkingEnabled;
    if (reasoningEffort) {
      settings.reasoningEffort = reasoningEffort;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 mode 持久化到 settings.json。
 * 成功返回 true，失败返回 false。
 */
export function updateModeInSettings(mode: ModelMode): boolean {
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as DeepcodingSettings;
    settings.mode = mode;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 verboseMode 持久化到 settings.json。
 * 成功返回 true，失败返回 false。
 */
export function updateVerboseModeInSettings(verboseMode: boolean): boolean {
  try {
    const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
    const raw = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as DeepcodingSettings;
    settings.verboseMode = verboseMode;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// debug-test-end
// thinking-test-passed
// savings-test
// model-detail-test
// model-detail-fix-verified
// pricing-fix-verified
// sum-cost-fix-verified
// newline-fix-verified
// dot-fix-verified
// newline-fix-final
