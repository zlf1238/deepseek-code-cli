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

/** Short provider tag shown in the model picker dropdown. */
export function getModelProviderLabel(model: string): string {
  if (DEEPSEEK_V4_MODELS.has(model)) return "DeepSeek";
  if (model.startsWith("glm-")) return "Zhipu";
  return "";
}
