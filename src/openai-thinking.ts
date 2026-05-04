import type { ReasoningEffort } from "./settings";

type ThinkingConfig = {
  type: "enabled";
};

type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  extra_body?: {
    thinking?: ThinkingConfig;
    reasoning_effort?: ReasoningEffort;
  };
};

export function buildThinkingRequestOptions(
  thinkingEnabled: boolean,
  baseURL?: string,
  reasoningEffort: ReasoningEffort = "max"
): ThinkingRequestOptions {
  if (!thinkingEnabled) {
    return {};
  }

  const thinking: ThinkingConfig = { type: "enabled" };
  const normalizedBaseURL = baseURL?.toLowerCase() ?? "";

  if (normalizedBaseURL.includes(".volces.com")) {
    return {
      thinking,
      extra_body: { reasoning_effort: reasoningEffort }
    };
  }

  return {
    extra_body: {
      thinking,
      reasoning_effort: reasoningEffort
    }
  };
}
