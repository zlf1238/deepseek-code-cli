/** 状态行构建模块 */
import type { SessionEntry, SessionStatus } from "../session";
import type { PricingConfig } from "../settings";

/**
 * 构建状态栏文本，格式如：
 * ✓ deepseek-v4-pro · 28.5k/200k (14%) · 缓存 89% · ¥0.016
 */
export function buildStatusLine(
  entry: SessionEntry,
  activeModel?: string,
  pricing?: Required<PricingConfig>,
): string {
  const parts: string[] = [];

  // 状态图标 + 模型名（放在最前面）
  const emoji = statusToEmoji(entry.status);
  parts.push(`${emoji} ${activeModel ?? "unknown"}`);

  // Token 用量
  if (typeof entry.activeTokens === "number" && entry.activeTokens > 0) {
    const current = formatTokenCount(entry.activeTokens);
    if (entry.compactThreshold && entry.compactThreshold > 0) {
      const max = formatTokenCount(entry.compactThreshold);
      const pct = Math.round((entry.activeTokens / entry.compactThreshold) * 100);
      parts.push(`${current}/${max} (${pct}%)`);
    } else {
      parts.push(`${current}`);
    }
  }

  // 缓存命中率（从 usage 中解析）
  if (entry.usage && typeof entry.usage === "object") {
    const usage = entry.usage as Record<string, unknown>;
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cachedTokens = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
    if (promptTokens > 0 && cachedTokens > 0) {
      const hitPct = Math.round((cachedTokens / promptTokens) * 100);
      parts.push(`缓存 ${hitPct}%`);
    }
  }

  // 费用（需定价信息）
  if (pricing && entry.usage && typeof entry.usage === "object") {
    const usage = entry.usage as Record<string, unknown>;
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cachedTokens = details && typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
    const missTokens = Math.max(0, promptTokens - cachedTokens);

    let cost = 0;
    cost += (cachedTokens / 1_000_000) * pricing.inputCacheHitPricePerMillion;
    cost += (missTokens / 1_000_000) * pricing.inputCacheMissPricePerMillion;
    cost += (completionTokens / 1_000_000) * pricing.outputPricePerMillion;

    if (cost > 0) {
      parts.push(`¥${formatCost(cost)}`);
    }
  }

  if (entry.failReason) {
    parts.push(`失败: ${entry.failReason}`);
  }
  return parts.join(" · ");
}

/** 将会话状态映射为 Emoji 图标 */
export function statusToEmoji(status: SessionStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "failed": return "✗";
    case "interrupted": return "⚠";
    case "processing": return "⟳";
    case "pending": return "⋯";
    case "waiting_for_user": return "?";
    default: return "•";
  }
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
