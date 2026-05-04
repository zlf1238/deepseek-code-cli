import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompletionSummary, formatElapsed } from "../ui/App";
import type { SessionEntry } from "../session";

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
  const msg = buildCompletionSummary(session, 5230);

  assert.equal(msg.role, "system");
  assert.equal(msg.visible, true);
  assert.equal(msg.meta?.isSummary, true);
  assert.ok(msg.content.includes("✓ completed"));
  assert.ok(msg.content.includes("⏱ 5.2s"));
  assert.ok(msg.content.includes("token: 1.2k"));
  assert.equal(msg.messageParams?.statusColor, "green");
});

test("buildCompletionSummary shows failed status in red", () => {
  const session = makeSession({
    status: "failed",
    usage: { total_tokens: 500 }
  });
  const msg = buildCompletionSummary(session, 3000);

  assert.ok(msg.content.includes("✗ failed"));
  assert.equal(msg.messageParams?.statusColor, "red");
});

test("buildCompletionSummary shows interrupted status in yellow", () => {
  const session = makeSession({
    status: "interrupted",
    usage: { total_tokens: 800 }
  });
  const msg = buildCompletionSummary(session, 15000);

  assert.ok(msg.content.includes("⚠ interrupted"));
  assert.equal(msg.messageParams?.statusColor, "yellow");
});

test("buildCompletionSummary omits token info when usage is null", () => {
  const session = makeSession({
    status: "completed",
    usage: null
  });
  const msg = buildCompletionSummary(session, 1000);

  assert.ok(!msg.content.includes("token:"));
  assert.equal(msg.content.includes("✓ completed"), true);
});

test("buildCompletionSummary omits token info when total_tokens is 0", () => {
  const session = makeSession({
    usage: { total_tokens: 0 }
  });
  const msg = buildCompletionSummary(session, 2000);

  assert.ok(!msg.content.includes("token:"));
});

test("buildCompletionSummary handles large token counts", () => {
  const session = makeSession({
    usage: { total_tokens: 1_200_000 }
  });
  const msg = buildCompletionSummary(session, 300000);

  assert.ok(msg.content.includes("token: 1M"));
  assert.ok(msg.content.includes("⏱ 5m0s"));
});

test("buildCompletionSummary uses the correct session id", () => {
  const session = makeSession({ id: "abc-123" });
  const msg = buildCompletionSummary(session, 500);

  assert.equal(msg.sessionId, "abc-123");
});

test("buildCompletionSummary generates a unique id per call", () => {
  const session = makeSession();
  const msg1 = buildCompletionSummary(session, 100);
  const msg2 = buildCompletionSummary(session, 200);

  assert.notEqual(msg1.id, msg2.id);
});
