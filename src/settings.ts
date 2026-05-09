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

export type DeepcodingSettings = {
  env?: DeepcodingEnv;
  models?: Record<string, ModelOverride>;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  notify?: string;
  webSearchTool?: string;
  pricing?: PricingConfig;
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
};

function resolveReasoningEffort(value: unknown): ReasoningEffort {
  return value === "high" || value === "max" ? value : "max";
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
    // 1. Per-model pricing
    const modelPrice = modelOverride?.pricing?.[field];
    if (typeof modelPrice === "number" && !Number.isNaN(modelPrice)) {
      return modelPrice;
    }
    // 2. Global pricing
    const globalPrice = settings?.pricing?.[field];
    if (typeof globalPrice === "number" && !Number.isNaN(globalPrice)) {
      return globalPrice;
    }
    // 3. Default
    return 0;
  };

  const resolveCachePrice = (field: "inputCacheHitPricePerMillion" | "inputCacheMissPricePerMillion"): number => {
    // 1. Per-model pricing
    const modelPrice = modelOverride?.pricing?.[field];
    if (typeof modelPrice === "number" && !Number.isNaN(modelPrice)) {
      return modelPrice;
    }
    // 2. Global pricing
    const globalPrice = settings?.pricing?.[field];
    if (typeof globalPrice === "number" && !Number.isNaN(globalPrice)) {
      return globalPrice;
    }
    // 3. Fall back to inputPricePerMillion (for cache fields, also try the resolved input price)
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
    pricing
  };
}

/** Return all model names declared in settings (env.MODEL + models keys), deduped. */
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
 * Persist the active model name to settings.json by updating env.MODEL.
 * Returns true on success, false on failure.
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
 * Persist thinkingEnabled and reasoningEffort to settings.json.
 * Returns true on success, false on failure.
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
