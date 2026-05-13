/**
 * 借鉴 Reasonix repair/truncation.ts: 修复 DeepSeek 因 max_tokens 截断导致的不完整 JSON。
 * 纯本地修复（补全括号、闭合字符串、填充 null），不消耗 API 调用。
 */

export interface TruncationRepairResult {
  repaired: string;
  changed: boolean;
  notes: string[];
}

export function repairTruncatedJson(input: string): TruncationRepairResult {
  if (!input || !input.trim()) {
    return { repaired: "{}", changed: input !== "{}", notes: ["empty input → {}"] };
  }

  // Fast path: already valid JSON
  try {
    JSON.parse(input);
    return { repaired: input, changed: false, notes: [] };
  } catch { /* fall through */ }

  const notes: string[] = [];
  const stack: ("{" | "[" | '"')[] = [];
  let escaped = false;
  let inString = false;
  let lastSignificant = -1;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (!/\s/.test(c)) lastSignificant = i;
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') { inString = false; stack.pop(); }
      continue;
    }
    if (c === '"') { inString = true; stack.push('"'); continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }

  let s = input.slice(0, lastSignificant + 1);

  // Trim trailing comma
  if (/,$/.test(s)) {
    s = s.replace(/,$/, "");
    notes.push("trimmed trailing comma");
  }

  // Dangling key without value: "foo": → "foo": null
  if (/"\s*:\s*$/.test(s)) {
    s += " null";
    notes.push("filled dangling key with null");
  }

  // Close unterminated string
  if (inString) {
    s += '"';
    stack.pop();
    notes.push("closed unterminated string");
  }

  // Close remaining structures in reverse order
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === "{") s += "}";
    else if (top === "[") s += "]";
    else if (top === '"') s += '"';
  }

  try {
    JSON.parse(s);
    return { repaired: s, changed: true, notes };
  } catch (err) {
    notes.push(`fallback to {}: ${(err as Error).message}`);
    return { repaired: "{}", changed: true, notes };
  }
}
