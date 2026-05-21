/** 完成摘要构建模块 */
import type { SessionEntry, SessionMessage } from "../session";
import type { PricingConfig } from "../settings";
import { statusToEmoji } from "./statusLine";

/**
 * 构建本轮完成摘要消息，格式如：
 * ✓ 22.3s · deepseek-v4-pro: 输入 6.8k/输出 2.1k · 缓存 89% · ¥0.016
 */
export function buildCompletionSummary(
  session: SessionEntry,
  elapsedMs: number,
  roundTokens: number,
  roundPromptTokens: number,
  roundCompletionTokens: number,
  roundCacheHitTokens: number,
  roundCacheMissTokens: number,
  pricing: Required<PricingConfig>,
  usageByModelDiff?: Record<string, Record<string, number>>,
  resolveModelPricing?: (modelName: string) => Required<PricingConfig>,
): SessionMessage {
  const now = new Date().toISOString();
  const elapsed = formatElapsed(elapsedMs);

  let statusColor = "";
  switch (session.status) {
    case "completed": statusColor = "green"; break;
    case "failed": statusColor = "red"; break;
    case "interrupted": statusColor = "yellow"; break;
    default: statusColor = "gray";
  }

  const parts: string[] = [`${statusToEmoji(session.status)} ${elapsed}`];

  let cacheTotal = roundCacheHitTokens + roundCacheMissTokens;
  let sumCost = 0;

  if (usageByModelDiff && resolveModelPricing) {
    const modelNames = Object.keys(usageByModelDiff).sort();
    let sumModelCost = 0;

    for (const modelName of modelNames) {
      const diff = usageByModelDiff[modelName];
      const modelPrompt = typeof diff.prompt_tokens === "number" ? diff.prompt_tokens : 0;
      const modelCompletion = typeof diff.completion_tokens === "number" ? diff.completion_tokens : 0;
      const modelCacheHit = typeof diff.prompt_cache_hit_tokens === "number" ? diff.prompt_cache_hit_tokens : 0;
      const modelCacheMiss = typeof diff.prompt_cache_miss_tokens === "number" ? diff.prompt_cache_miss_tokens : 0;

      const mp = resolveModelPricing(modelName);
      const mHitPrice = mp.inputCacheHitPricePerMillion > 0
        ? mp.inputCacheHitPricePerMillion
        : mp.inputPricePerMillion;
      const mMissPrice = mp.inputCacheMissPricePerMillion > 0
        ? mp.inputCacheMissPricePerMillion
        : mp.inputPricePerMillion;

      const modelCost =
        (modelCacheHit / 1_000_000) * mHitPrice
        + (modelCacheMiss / 1_000_000) * mMissPrice
        + (modelCompletion / 1_000_000) * mp.outputPricePerMillion;
      sumModelCost += modelCost;

      parts.push(`${modelName}: 输入 ${formatTokenCount(modelPrompt)}/输出 ${formatTokenCount(modelCompletion)}`);
    }
    sumCost = sumModelCost;
  } else {
    parts.push(`输入 ${formatTokenCount(roundPromptTokens)}/输出 ${formatTokenCount(roundCompletionTokens)}`);
  }

  if (cacheTotal > 0) {
    const hitPct = Math.round((roundCacheHitTokens / cacheTotal) * 100);
    parts.push(`缓存 ${hitPct}%`);
  }

  if (sumCost > 0) {
    parts.push(`¥${formatCost(sumCost)}`);
  } else if (roundPromptTokens > 0 || roundCompletionTokens > 0) {
    const cacheHitPrice = pricing.inputCacheHitPricePerMillion > 0
      ? pricing.inputCacheHitPricePerMillion
      : pricing.inputPricePerMillion;
    const cacheMissPrice = pricing.inputCacheMissPricePerMillion > 0
      ? pricing.inputCacheMissPricePerMillion
      : pricing.inputPricePerMillion;

    let cost = 0;
    cost += (roundCacheHitTokens / 1_000_000) * cacheHitPrice;
    cost += (roundCacheMissTokens / 1_000_000) * cacheMissPrice;
    const nonCachePromptTokens = Math.max(0, roundPromptTokens - cacheTotal);
    cost += (nonCachePromptTokens / 1_000_000) * pricing.inputPricePerMillion;
    cost += (roundCompletionTokens / 1_000_000) * pricing.outputPricePerMillion;

    if (cost > 0) {
      parts.push(`¥${formatCost(cost)}`);
    }
  }

  return {
    id: `summary-${Math.random().toString(36).slice(2)}`,
    sessionId: session.id,
    role: "system",
    content: parts.join(" · "),
    contentParams: null,
    messageParams: { statusColor },
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
    meta: { isSummary: true },
  };
}

export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m${seconds}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.001) return cost.toFixed(6);
  if (cost < 0.01) return cost.toFixed(4);
  if (cost < 1) return cost.toFixed(3);
  if (cost < 10) return cost.toFixed(2);
  return cost.toFixed(1);
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
  return `${Math.round(tokens / 1000)}k`;
}
