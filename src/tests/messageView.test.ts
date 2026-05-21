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

test("MessageView hides assistant thinking messages", () => {
  const view = MessageView({ message: buildAssistantMessage({ content: "思考内容" }) });
  assert.equal(view, null);
});

test("MessageView shows assistant final answer", () => {
  const view = MessageView({ message: buildAssistantMessage({ meta: undefined, content: "最终回答" }) });
  assert.notEqual(view, null);
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

test("parseDiffPreview handles empty input", () => {
  assert.deepEqual(parseDiffPreview(""), []);
});

test("parseDiffPreview handles large diff with many lines", () => {
  const diff = Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n");
  const lines = parseDiffPreview(diff);
  assert.equal(lines.length, 20);
  assert.ok(lines.every((l) => l.kind === "added"));
});
