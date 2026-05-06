import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageView, parseDiffPreview } from "../ui/MessageView";
import type { SessionMessage } from "../session";

test("parseDiffPreview removes headers and classifies lines", () => {
  const lines = parseDiffPreview([
    "--- a/file.txt",
    "+++ b/file.txt",
    "@@ -1,1 +1,1 @@",
    " context",
    "-old",
    "+new"
  ].join("\n"));

  assert.deepEqual(lines, [
    { marker: " ", content: "context", kind: "context" },
    { marker: "-", content: "old", kind: "removed" },
    { marker: "+", content: "new", kind: "added" }
  ]);
});

test("parseDiffPreview keeps nonstandard context lines", () => {
  const lines = parseDiffPreview("...\n+added");
  assert.deepEqual(lines, [
    { marker: " ", content: "...", kind: "context" },
    { marker: "+", content: "added", kind: "added" }
  ]);
});

test("MessageView hides collapsed thinking", () => {
  const view = MessageView({ message: buildAssistantMessage({}), collapsed: true });
  assert.equal(view, null);
});

test("MessageView renders expanded thinking", () => {
  const view = MessageView({ message: buildAssistantMessage({ content: "思考中..." }), collapsed: false }) as any;
  assert.notEqual(view, null);
  // Should show the thinking content
  const hasThinkingContent = JSON.stringify(view).includes("思考中...");
  assert.equal(hasThinkingContent, true);
});

function buildAssistantMessage(overrides: Partial<SessionMessage>): SessionMessage {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    content: "",
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: "2026-01-01T00:00:00.000Z",
    updateTime: "2026-01-01T00:00:00.000Z",
    meta: { asThinking: true },
    ...overrides
  };
}
