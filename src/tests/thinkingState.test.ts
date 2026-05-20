import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMessage } from "../session";

// ── Pure-logic simulation of useThinkingExpanded hook ──

function filterThinkingIds(messages: SessionMessage[]): string[] {
  return messages
    .filter(
      (m) =>
        m.role === "assistant" &&
        m.meta?.asThinking &&
        m.visible !== false
    )
    .map((m) => m.id);
}

type State = {
  expandedIds: Set<string>;
  toggle: (id: string) => void;
  expandAll: (allIds: string[]) => void;
  collapseAll: () => void;
  isExpanded: (id: string) => boolean;
};

function createState(initialExpanded: string[] = []): State {
  const expanded = new Set(initialExpanded);
  return {
    expandedIds: expanded,
    toggle(id: string) {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
    },
    expandAll(allIds: string[]) { allIds.forEach((id) => expanded.add(id)); },
    collapseAll() { expanded.clear(); },
    isExpanded(id: string) { return expanded.has(id); },
  };
}

// ── Build helpers ──

function buildMessage(
  id: string,
  role: SessionMessage["role"],
  options: { asThinking?: boolean; visible?: boolean } = {}
): SessionMessage {
  const now = "2026-04-29T00:00:00.000Z";
  return {
    id,
    sessionId: "s",
    role,
    content: "",
    contentParams: null,
    messageParams: null,
    compacted: false,
    visible: options.visible ?? true,
    createTime: now,
    updateTime: now,
    meta: options.asThinking ? { asThinking: true } : undefined,
  };
}

// ── Tests ──

test("filterThinkingIds returns empty for messages with no asThinking", () => {
  const messages = [
    buildMessage("u", "user"),
    buildMessage("a", "assistant"),
    buildMessage("t", "tool"),
  ];
  assert.deepEqual(filterThinkingIds(messages), []);
});

test("filterThinkingIds collects only asThinking assistant messages", () => {
  const messages = [
    buildMessage("a1", "assistant", { asThinking: true }),
    buildMessage("t", "tool"),
    buildMessage("a2", "assistant", { asThinking: true }),
    buildMessage("a3", "assistant"),
  ];
  assert.deepEqual(filterThinkingIds(messages), ["a1", "a2"]);
});

test("filterThinkingIds excludes invisible messages", () => {
  const messages = [
    buildMessage("a1", "assistant", { asThinking: true }),
    buildMessage("a2", "assistant", { asThinking: true, visible: false }),
  ];
  assert.deepEqual(filterThinkingIds(messages), ["a1"]);
});

test("defaultExpanded='none' starts with empty expanded set", () => {
  const state = createState();
  assert.equal(state.isExpanded("any-id"), false);
});

test("defaultExpanded='latest' starts with only latest expanded", () => {
  const state = createState(["latest-id"]);
  assert.equal(state.isExpanded("latest-id"), true);
  assert.equal(state.isExpanded("other-id"), false);
});

test("defaultExpanded='all' starts with all expanded", () => {
  const state = createState(["id1", "id2", "id3"]);
  assert.equal(state.isExpanded("id1"), true);
  assert.equal(state.isExpanded("id2"), true);
  assert.equal(state.isExpanded("id3"), true);
});

test("toggle adds then removes an id", () => {
  const state = createState();
  state.toggle("id1");
  assert.equal(state.isExpanded("id1"), true);
  state.toggle("id1");
  assert.equal(state.isExpanded("id1"), false);
});

test("expandAll adds all provided ids", () => {
  const state = createState();
  state.expandAll(["a", "b", "c"]);
  assert.equal(state.isExpanded("a"), true);
  assert.equal(state.isExpanded("b"), true);
  assert.equal(state.isExpanded("c"), true);
});

test("collapseAll clears all expanded ids", () => {
  const state = createState(["a", "b"]);
  state.collapseAll();
  assert.equal(state.isExpanded("a"), false);
  assert.equal(state.isExpanded("b"), false);
});
