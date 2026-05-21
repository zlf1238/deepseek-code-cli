import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoadingText, buildProgressBar } from "../ui/loadingText";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// buildProgressBar 测试（3.2 新功能）
// ---------------------------------------------------------------------------

test("buildProgressBar shows full bar at 100%", () => {
  const result = buildProgressBar(100, 10);
  assert.equal(result, "[██████████] 100%");
});

test("buildProgressBar shows empty bar at 0%", () => {
  const result = buildProgressBar(0, 10);
  assert.equal(result, "[░░░░░░░░░░] 0%");
});

test("buildProgressBar shows partial bar", () => {
  const result = buildProgressBar(40, 10);
  // 40% of 10 = 4 filled
  assert.equal(result, "[████░░░░░░] 40%");
});

test("buildProgressBar clamps to width", () => {
  const result = buildProgressBar(200, 8);
  assert.equal(result, "[████████] 100%");
});

// ---------------------------------------------------------------------------
// buildLoadingText 测试
// ---------------------------------------------------------------------------

test("buildLoadingText returns plain Generating... when no progress", () => {
  assert.equal(buildLoadingText({ progress: null, now: Date.now() }), "Generating...");
});

test("buildLoadingText shows running process elapsed time before thinking progress", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 5_750;
  const processes = new Map([
    ["123", { startTime: startedAt, command: "yarn install" }]
  ]);
  const text = buildLoadingText({
    processes,
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 850,
      formattedTokens: "850",
      phase: "update"
    },
    now
  });
  assert.equal(text, "(5s) yarn install");
});

test("buildLoadingText formats long-running process time with minutes", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 65_250;
  const processes = new Map([
    ["web-search", { startTime: startedAt, command: "WebSearch: latest node release" }]
  ]);
  assert.equal(
    buildLoadingText({ processes, progress: null, now }),
    "(1m5s) WebSearch: latest node release"
  );
});

test("buildLoadingText returns plain Generating... while elapsed below 3s", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 1500;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 12,
      formattedTokens: "12",
      phase: "update"
    },
    now
  });
  assert.equal(text, "Generating...");
});

test("buildLoadingText shows elapsed seconds and tokens with progress bar once past the threshold", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 5_750;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 850,
      formattedTokens: "850",
      phase: "update"
    },
    now
  });
  // 应包含 elapsed 和 tokens 和进度条
  assert.ok(text.startsWith("Generating... (5s) · ↓ 850 tokens · ["));
  assert.ok(text.includes("█"));
  assert.ok(text.includes("░"));
});

test("buildLoadingText falls back to '0' when formattedTokens is missing", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 4_000;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 0,
      formattedTokens: "",
      phase: "update"
    },
    now
  });
  assert.ok(text.includes(" ↓ 0 tokens"));
  assert.ok(text.includes("["));
});

test("buildLoadingText falls back to Generating... when timestamp is unparseable", () => {
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt: "not-a-date",
      estimatedTokens: 0,
      formattedTokens: "0",
      phase: "update"
    },
    now: Date.now()
  });
  assert.equal(text, "Generating...");
});

test("buildLoadingText shows progress bar percentage increases over time", () => {
  const startedAt = "2026-04-28T00:00:00.000Z";
  const now = Date.parse(startedAt) + 10_000;
  const text = buildLoadingText({
    progress: {
      requestId: "r",
      startedAt,
      estimatedTokens: 2000,
      formattedTokens: "2k",
      phase: "update"
    },
    now
  });
  // At 10s (10000ms), pct = min(100, round(10000/10000*100)) = 100%
  assert.ok(text.includes("100%"));
});
