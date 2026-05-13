import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

type ChoiceOption = {
  id: string;
  label: string;
  description?: string;
};

type AskChoiceMetadata = {
  kind: "ask_choice";
  question: string;
  options: ChoiceOption[];
  multiSelect: boolean;
  allowCustom: boolean;
};

export async function handleAskChoiceTool(
  args: Record<string, unknown>,
  _context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return { ok: false, name: "ask_choice", error: "Missing required \"question\" string." };
  }

  const rawOptions = args.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return { ok: false, name: "ask_choice", error: "\"options\" must be a non-empty array." };
  }

  if (rawOptions.length > 6) {
    return { ok: false, name: "ask_choice", error: "Maximum 6 options allowed." };
  }

  const options: ChoiceOption[] = [];
  for (let i = 0; i < rawOptions.length; i++) {
    const opt = rawOptions[i];
    if (!opt || typeof opt !== "object") {
      return { ok: false, name: "ask_choice", error: `Option at index ${i} must be an object.` };
    }
    const id = typeof (opt as Record<string, unknown>).id === "string"
      ? (opt as Record<string, unknown>).id as string
      : String.fromCharCode(65 + i); // A, B, C, ...
    const label = typeof (opt as Record<string, unknown>).label === "string"
      ? (opt as Record<string, unknown>).label as string
      : "";
    if (!label.trim()) {
      return { ok: false, name: "ask_choice", error: `Option at index ${i} missing "label".` };
    }
    options.push({
      id,
      label: label.trim(),
      description: typeof (opt as Record<string, unknown>).description === "string"
        ? (opt as Record<string, unknown>).description as string
        : undefined,
    });
  }

  const metadata: AskChoiceMetadata = {
    kind: "ask_choice",
    question,
    options,
    multiSelect: args.multiSelect === true,
    allowCustom: args.allowCustom !== false,
  };

  const summary = [
    `Q: ${question}`,
    options.map((o) => `  [${o.id}] ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n"),
    metadata.allowCustom ? "  [Custom answer allowed]" : "",
  ].join("\n");

  return {
    ok: true,
    name: "ask_choice",
    output: summary,
    metadata: metadata as unknown as Record<string, unknown>,
    awaitUserResponse: true,
  };
}
