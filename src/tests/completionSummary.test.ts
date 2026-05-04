import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSummary, formatElapsed } from "../ui/App";
import type { SessionEntry } from "../session";
import type { PricingConfig } from "../settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_PRICING: Required<PricingConfig> = { inputPricePerMillion: 0, outputPricePerMillion: 0 };
const WITH_PRICING: Required<PricingConfig> = { inputPricePerMillion: 0.27, outputPricePerMillion: 1.10 };

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

test("formatElapsed returns sub-second precision for values below 60s", () => {
  assert.equal(formatElapsed(0), "0.0s");
  assert.equal(formatElapsed(500), "0.5s");
  assert.equal(formatElapsed(1234), "1.2s");
  assert.equal(formatElapsed(59300), "59.3s");
});

test("formatElapsed switches to minutes:seconds at 60s", () => {
  assert.equal(formatElapsed(60000), "1m0s");
  assert.equal(formatElapsed(60001), "1m0s");
  assert.equal(formatElapsed(120000), "2m0s");
});

test("formatElapsed formats longer durations", () => {
  assert.equal(formatElapsed(125000), "2m5s");
  assert.equal(formatElapsed(3600000), "60m0s");
  assert.equal(formatElapsed(3661000), "61m1s");
});

// ---------------------------------------------------------------------------
// buildCompletionSummary
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: "session-1",
    summary: "test summary",
    assistantReply: null,
    assistantThinking: null,
    assistantRefusal: null,
    toolCalls: null,
    status: "completed",
    failReason: null,
    usage: null,
    activeTokens: 0,
    compactThreshold: 0,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
    processes: null,
    ...overrides
  };
}

test("buildCompletionSummary includes elapsed time and token count for completed session", () => {
  const session = makeSession({
    usage: { total_tokens: 1234 }
  });
  const msg = buildCompletionSummary(session, 5230, 1234, 1000, 234, NO_PRICING);

  assert.equal(msg.role, "system");
  assert.equal(msg.visible, true);
  assert.equal(msg.meta?.isSummary, true);
  assert.ok(msg.content?.includes("✓ completed"));
  assert.ok(msg.content?.includes("耗时: 5.2s"));
  assert.ok(msg.content?.includes("token: 1.2k"));
  assert.equal((msg.messageParams as any)?.statusColor, "green");
});

test("buildCompletionSummary shows failed status in red", () => {
  const session = makeSession({
    status: "failed",
    usage: { total_tokens: 500 }
  });
  const msg = buildCompletionSummary(session, 3000, 500, 400, 100, NO_PRICING);

  assert.ok(msg.content?.includes("✗ failed"));
  assert.equal((msg.messageParams as any)?.statusColor, "red");
});

test("buildCompletionSummary shows interrupted status in yellow", () => {
  const session = makeSession({
    status: "interrupted",
    usage: { total_tokens: 800 }
  });
  const msg = buildCompletionSummary(session, 15000, 800, 600, 200, NO_PRICING);

  assert.ok(msg.content?.includes("⚠ interrupted"));
  assert.equal((msg.messageParams as any)?.statusColor, "yellow");
});

test("buildCompletionSummary omits cost when pricing is zero", () => {
  const session = makeSession({ status: "completed" });
  const msg = buildCompletionSummary(session, 1000, 1000, 800, 200, NO_PRICING);

  assert.ok(msg.content?.includes("✓ completed"));
  assert.ok(msg.content?.includes("token: 1.0k"));
  assert.ok(!msg.content?.includes("费用:"));
});

test("buildCompletionSummary calculates cost with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 800k input × 0.27/1M + 200k output × 1.10/1M
  // = 0.216 + 0.220 = 0.436
  const msg = buildCompletionSummary(session, 5000, 1_000_000, 800_000, 200_000, WITH_PRICING);

  assert.ok(msg.content?.includes("token: 1M"));
  assert.ok(msg.content?.includes("费用: ¥0.436"));
});

test("buildCompletionSummary handles large token counts with pricing", () => {
  const session = makeSession({ status: "completed" });
  // 1M input × 0.27 + 2M output × 1.10 = 0.27 + 2.20 = 2.47
  const msg = buildCompletionSummary(session, 300000, 3_000_000, 1_000_000, 2_000_000, WITH_PRICING);

  assert.ok(msg.content?.includes("token: 3M"));
  assert.ok(msg.content?.includes("费用: ¥2.47"));
});

test("buildCompletionSummary uses the correct session id", () => {
  const session = makeSession({ id: "abc-123" });
  const msg = buildCompletionSummary(session, 500, 100, 80, 20, NO_PRICING);

  assert.equal(msg.sessionId, "abc-123");
});

test("buildCompletionSummary generates a unique id per call", () => {
  const session = makeSession();
  const msg1 = buildCompletionSummary(session, 100, 50, 40, 10, NO_PRICING);
  const msg2 = buildCompletionSummary(session, 200, 50, 40, 10, NO_PRICING);

  assert.notEqual(msg1.id, msg2.id);
});
