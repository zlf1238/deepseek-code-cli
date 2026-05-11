import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { defaultsToThinkingMode } from "./model-capabilities";

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
  /** 预估每轮 output token 数（默认 2000），用于计算 roundSaving */
  estimatedOutputPerRound?: number;
};

export type RTKSettings = {
  /** 是否启用 RTK 输出压缩（默认 false） */
  enabled?: boolean;
  /** RTK 二进制路径（默认 "rtk"） */
  binaryPath?: string;
};

export type DeepcodingSettings = {
  env?: DeepcodingEnv;
  models?: Record<string, ModelOverride>;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  notify?: string;
  webSearchTool?: string;
  pricing?: PricingConfig;
  autoSwitch?: AutoSwitchConfig;
  rtk?: RTKSettings;
};

export type ResolvedAutoSwitchConfig = {
  enabled: boolean;
  maxPaybackRounds: number;
  estimatedOutputPerRound: number;
};

export type ResolvedDeepcodingSettings = {
  apiKey?: string;
  baseURL: string;
  model: string;
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
  return { enabled, maxPaybackRounds, estimatedOutputPerRound };
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
    // 3. 默认值
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
    // 3. 回退到 inputPricePerMillion（缓存字段也会尝试解析后的 input 价格）
    return 0;
  };

  const pricing: Required<PricingConfig> = {
    inputPricePerMillion: resolvePrice("inputPricePerMillion"),
    outputPricePerMillion: resolvePrice("outputPricePerMillion"),
    inputCacheHitPricePerMillion: resolveCachePrice("inputCacheHitPricePerMillion"),
    inputCacheMissPricePerMillion: resolveCachePrice("inputCacheMissPricePerMillion"),
  };

  return {
    apiKey: resolvedApiKey,
    baseURL: resolvedBaseURL,
    model,
    thinkingEnabled: resolveThinkingEnabled(settings, model),
    reasoningEffort: resolveReasoningEffort(settings?.reasoningEffort),
    notify: notify || undefined,
    webSearchTool: webSearchTool || undefined,
    pricing,
    autoSwitch: resolveAutoSwitchConfig(settings)
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
