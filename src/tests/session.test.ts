import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager, type SessionMessage } from "../session";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("SessionManager preserves structured system content when building OpenAI messages", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });

  const messages: SessionMessage[] = [
    {
      id: "system-image",
      sessionId: "session-1",
      role: "system",
      content: "The read tool has loaded `pixel.png`.",
      contentParams: [
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,abc123" }
        }
      ],
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z"
    }
  ];

  const openAIMessages = (manager as any).buildOpenAIMessages(messages) as Array<{
    role: string;
    content: unknown;
  }>;

  assert.equal(openAIMessages.length, 1);
  assert.equal(openAIMessages[0]?.role, "system");
  assert.deepEqual(openAIMessages[0]?.content, [
    { type: "text", text: "The read tool has loaded `pixel.png`." },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" }
    }
  ]);
});

test("SessionManager preserves empty reasoning content on assistant tool calls", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });

  const message = (manager as any).buildAssistantMessage(
    "session-1",
    "",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" }
      }
    ],
    ""
  ) as SessionMessage;

  assert.deepEqual(message.messageParams, {
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: "{}" }
      }
    ],
    reasoning_content: ""
  });

  const openAIMessages = (manager as any).buildOpenAIMessages([message], true) as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(openAIMessages[0]?.reasoning_content, "");
});

test("SessionManager repairs legacy thinking tool calls missing reasoning content", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-tool",
      sessionId: "session-1",
      role: "assistant",
      content: "",
      contentParams: null,
      messageParams: {
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read", arguments: "{}" }
          }
        ]
      },
      compacted: false,
      visible: false,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z"
    }
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true) as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false) as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(
    Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"),
    false
  );
});

test("SessionManager replays normal assistant messages with reasoning content in thinking mode", () => {
  const manager = new SessionManager({
    projectRoot: process.cwd(),
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });

  const messages: SessionMessage[] = [
    {
      id: "assistant-final",
      sessionId: "session-1",
      role: "assistant",
      content: "Final answer",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z"
    }
  ];

  const thinkingMessages = (manager as any).buildOpenAIMessages(messages, true) as Array<{
    reasoning_content?: string;
  }>;
  const nonThinkingMessages = (manager as any).buildOpenAIMessages(messages, false) as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(thinkingMessages[0]?.reasoning_content, "");
  assert.equal(
    Object.prototype.hasOwnProperty.call(nonThinkingMessages[0] ?? {}, "reasoning_content"),
    false
  );
});

test("SessionManager normalizes legacy sessions without activeTokens to zero", () => {
  const workspace = createTempDir("deepseek-code-legacy-active-tokens-workspace-");
  const home = createTempDir("deepseek-code-legacy-active-tokens-home-");
  process.env.HOME = home;

  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "legacy-session",
          status: "completed",
          usage: { total_tokens: 123 },
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-legacy");

  assert.equal(manager.getSession("legacy-session")?.activeTokens, 0);
});

test("SessionManager marks skills loaded from existing session messages", async () => {
  const workspace = createTempDir("deepseek-code-loaded-skills-workspace-");
  const home = createTempDir("deepseek-code-loaded-skills-home-");
  process.env.HOME = home;

  const skillDir = path.join(home, ".agents", "skills", "lessweb-starter");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: lessweb-starter\ndescription: Create Lessweb projects\n---\n# Lessweb Starter\n",
    "utf8"
  );

  const projectCode = workspace.replace(/[\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "loaded-session.jsonl"),
    `${JSON.stringify({
      id: "skill-message",
      sessionId: "loaded-session",
      role: "system",
      content: "Use the skill document below",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "2026-01-01T00:00:00.000Z",
      updateTime: "2026-01-01T00:00:00.000Z",
      meta: {
        skill: {
          name: "lessweb-starter",
          path: "~/.agents/skills/lessweb-starter/SKILL.md",
          description: "Create Lessweb projects",
          isLoaded: true
        }
      }
    })}\n`,
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-loaded-skills");
  const loadedSkill = (await manager.listSkills("loaded-session"))
    .find((skill) => skill.name === "lessweb-starter");

  assert.equal(loadedSkill?.isLoaded, true);
});

test("replySession closes pending tool calls before appending a new user message", async () => {
  const workspace = createTempDir("deepseek-code-pending-tool-workspace-");
  const home = createTempDir("deepseek-code-pending-tool-home-");
  process.env.HOME = home;

  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => ""
  }) as Response) as typeof fetch;

  const manager = createSessionManager(workspace, "machine-id-pending-tool");
  (manager as any).activateSession = async () => {};

  const sessionId = await manager.createSession({ text: "first prompt" });
  const assistantMessage = (manager as any).buildAssistantMessage(
    sessionId,
    "I will run a tool.",
    [
      {
        id: "call-1",
        type: "function",
        function: { name: "bash", arguments: "{\"command\":\"sleep 100\"}" }
      }
    ],
    ""
  ) as SessionMessage;
  (manager as any).appendSessionMessage(sessionId, assistantMessage);

  await manager.replySession(sessionId, { text: "second prompt" });

  const messages = manager.listSessionMessages(sessionId);
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessage.id);
  assert.notEqual(assistantIndex, -1);
  assert.equal(messages[assistantIndex + 1]?.role, "tool");
  assert.equal((messages[assistantIndex + 1]?.messageParams as any)?.tool_call_id, "call-1");
  assert.match(String(messages[assistantIndex + 1]?.content), /Previous tool call did not complete/);
  assert.equal(messages[assistantIndex + 2]?.role, "user");
  assert.equal(messages[assistantIndex + 2]?.content, "second prompt");
});

test("SessionManager accumulates response usage while active tokens track the latest response", async () => {
  const workspace = createTempDir("deepseek-code-usage-workspace-");
  const home = createTempDir("deepseek-code-usage-home-");
  process.env.HOME = home;

  const responses = [
    createChatResponse("first", {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 3
    }),
    createChatResponse("second", {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 4 },
      prompt_cache_hit_tokens: 11,
      prompt_cache_miss_tokens: 9
    })
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  assert.equal(session?.activeTokens, 27);
  assert.equal(usage.prompt_tokens, 30);
  assert.equal(usage.completion_tokens, 12);
  assert.equal(usage.total_tokens, 42);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 18);
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 7);
  assert.equal(usage.prompt_cache_hit_tokens, 18);
  assert.equal(usage.prompt_cache_miss_tokens, 12);
});

test("SessionManager resets active tokens to latest post-compaction response usage", async () => {
  const workspace = createTempDir("deepseek-code-compact-usage-workspace-");
  const home = createTempDir("deepseek-code-compact-usage-home-");
  process.env.HOME = home;

  const responses = [
    createChatResponse("large", {
      prompt_tokens: 139_990,
      completion_tokens: 10,
      total_tokens: 140_000
    }),
    createChatResponse("summary", {
      prompt_tokens: 100,
      completion_tokens: 23,
      total_tokens: 123
    }),
    createChatResponse("after compact", {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7
    })
  ];
  const manager = createMockedClientSessionManager(workspace, responses);

  const sessionId = await manager.createSession({ text: "" });
  assert.equal(manager.getSession(sessionId)?.activeTokens, 140_000);

  await manager.replySession(sessionId, { text: "" });

  const session = manager.getSession(sessionId);
  const usage = session?.usage as Record<string, any>;
  assert.equal(session?.activeTokens, 7);
  assert.equal(usage.prompt_tokens, 140_095);
  assert.equal(usage.completion_tokens, 35);
  assert.equal(usage.total_tokens, 140_130);
});

test("SessionManager streams chat completions and counts reasoning progress", async () => {
  const workspace = createTempDir("deepseek-code-stream-workspace-");
  const home = createTempDir("deepseek-code-stream-home-");
  process.env.HOME = home;

  const progressEvents: Array<{
    phase: string;
    estimatedTokens: number;
    formattedTokens: string;
  }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          assert.equal(request.stream, true);
          assert.deepEqual(request.stream_options, { include_usage: true });
          return createChatStreamResponse([
            { choices: [{ delta: { reasoning_content: "思考" } }] },
            { choices: [{ delta: { content: "hello" } }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5
              }
            }
          ]);
        }
      }
    }
  };

  const manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onLlmStreamProgress: (progress) => {
      progressEvents.push({
        phase: progress.phase,
        estimatedTokens: progress.estimatedTokens,
        formattedTokens: progress.formattedTokens
      });
    }
  });

  const sessionId = await manager.createSession({ text: "" });
  const assistantMessage = manager
    .listSessionMessages(sessionId)
    .find((message) => message.role === "assistant");

  assert.equal(assistantMessage?.content, "hello");
  assert.equal((assistantMessage?.messageParams as any)?.reasoning_content, "思考");
  assert.equal(manager.getSession(sessionId)?.activeTokens, 5);
  assert.deepEqual(
    progressEvents.map((event) => event.phase),
    ["start", "update", "update", "end"]
  );
  assert.equal(progressEvents[1]?.estimatedTokens, 1);
  assert.equal(progressEvents[2]?.formattedTokens, "3");
});

test("SessionManager cancels skill matching before a session is created", async () => {
  const workspace = createTempDir("deepseek-code-skill-abort-workspace-");
  const home = createTempDir("deepseek-code-skill-abort-home-");
  process.env.HOME = home;

  const skillDir = path.join(home, ".agents", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
    "utf8"
  );

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
            queueMicrotask(() => manager.interruptActiveSession());
          });
        }
      }
    }
  };

  manager = createMockedClientSessionManagerWithClient(workspace, client);

  await manager.handleUserPrompt({ text: "please use demo" });

  assert.equal(manager.listSessions().length, 0);
});

test("SessionManager treats OpenAI APIUserAbortError as interrupted", async () => {
  const workspace = createTempDir("deepseek-code-api-abort-workspace-");
  const home = createTempDir("deepseek-code-api-abort-home-");
  process.env.HOME = home;

  let manager: SessionManager;
  const client = {
    chat: {
      completions: {
        create: async (_request: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          });
        }
      }
    }
  };

  manager = new SessionManager({
    projectRoot: workspace,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {},
    onSessionEntryUpdated: (entry) => {
      if (entry.status === "processing") {
        queueMicrotask(() => manager.interruptActiveSession());
      }
    }
  });

  await manager.handleUserPrompt({ text: "" });

  const activeSessionId = manager.getActiveSessionId();
  assert.ok(activeSessionId);
  const session = manager.getSession(activeSessionId);
  assert.equal(session?.status, "interrupted");
  assert.equal(session?.failReason, "interrupted");
});

test("listSessions cleans up stale processing sessions to interrupted", () => {
  const workspace = createTempDir("deepseek-code-stale-workspace-");
  const home = createTempDir("deepseek-code-stale-home-");
  process.env.HOME = home;

  const projectCode = workspace.replace(/[\\\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "processing-session",
          status: "processing",
          summary: null,
          assistantReply: null,
          assistantThinking: null,
          assistantRefusal: null,
          toolCalls: null,
          failReason: null,
          usage: null,
          activeTokens: 0,
          compactThreshold: 0,
          processes: null,
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "completed-session",
          status: "completed",
          summary: null,
          assistantReply: null,
          assistantThinking: null,
          assistantRefusal: null,
          toolCalls: null,
          failReason: null,
          usage: null,
          activeTokens: 0,
          compactThreshold: 0,
          processes: null,
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-stale");
  const sessions = manager.listSessions();

  assert.equal(sessions.length, 2);
  const interrupted = sessions.find((s) => s.id === "processing-session");
  const completed = sessions.find((s) => s.id === "completed-session");
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.failReason, "Previous session did not complete.");
  assert.equal(completed?.status, "completed");
});

test("listSessions does not double-clean up already interrupted sessions", () => {
  const workspace = createTempDir("deepseek-code-double-clean-workspace-");
  const home = createTempDir("deepseek-code-double-clean-home-");
  process.env.HOME = home;

  const projectCode = workspace.replace(/[\\\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  const indexPath = path.join(projectDir, "sessions-index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "s1",
          status: "processing",
          summary: null,
          assistantReply: null,
          assistantThinking: null,
          assistantRefusal: null,
          toolCalls: null,
          failReason: null,
          usage: null,
          activeTokens: 0,
          compactThreshold: 0,
          processes: null,
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-double");
  // First call cleans up
  assert.equal(manager.listSessions()[0]?.status, "interrupted");
  // Second call should not change anything and not corrupt the file
  assert.equal(manager.listSessions()[0]?.status, "interrupted");
  assert.equal(manager.listSessions().length, 1);
});

test("removeSessions deletes sessions and listSessions returns empty", () => {
  const workspace = createTempDir("deepseek-code-delete-workspace-");
  const home = createTempDir("deepseek-code-delete-home-");
  process.env.HOME = home;

  const projectCode = workspace.replace(/[\\\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "session-1",
          status: "completed",
          summary: null,
          assistantReply: null,
          assistantThinking: null,
          assistantRefusal: null,
          toolCalls: null,
          failReason: null,
          usage: null,
          activeTokens: 0,
          compactThreshold: 0,
          processes: null,
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-delete");
  assert.equal(manager.listSessions().length, 1);

  const removed = manager.removeSessions(["session-1"]);
  assert.equal(removed, 1);

  const sessionsAfter = manager.listSessions();
  assert.equal(sessionsAfter.length, 0);
});

test("listSessions picks up external index changes without stale cache", () => {
  const workspace = createTempDir("deepseek-code-nocache-workspace-");
  const home = createTempDir("deepseek-code-nocache-home-");
  process.env.HOME = home;

  const projectCode = workspace.replace(/[\\\\/]/g, "-").replace(/:/g, "");
  const projectDir = path.join(home, ".deepseek-code", "projects", projectCode);
  const indexPath = path.join(projectDir, "sessions-index.json");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: [
        {
          id: "s1",
          status: "completed",
          summary: null,
          assistantReply: null,
          assistantThinking: null,
          assistantRefusal: null,
          toolCalls: null,
          failReason: null,
          usage: null,
          activeTokens: 0,
          compactThreshold: 0,
          processes: null,
          createTime: "2026-01-01T00:00:00.000Z",
          updateTime: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const manager = createSessionManager(workspace, "machine-id-nocache");
  assert.equal(manager.listSessions().length, 1);

  // Simulate external process deleting the session by writing the file directly.
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 1,
      originalPath: workspace,
      entries: []
    }),
    "utf8"
  );

  const sessionsAfter = manager.listSessions();
  assert.equal(sessionsAfter.length, 0);
});

function createSessionManager(projectRoot: string, machineId: string): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: null,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      autoThinkingEnabled: false,
      machineId
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });
}

function createMockedClientSessionManager(projectRoot: string, responses: unknown[]): SessionManager {
  const client = {
    chat: {
      completions: {
        create: async () => {
          const response = responses.shift();
          assert.ok(response, "expected a queued chat response");
          return response;
        }
      }
    }
  };

  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });
}

function createMockedClientSessionManagerWithClient(projectRoot: string, client: unknown): SessionManager {
  return new SessionManager({
    projectRoot,
    createOpenAIClient: () => ({
      client: client as any,
      model: "test-model",
      baseURL: "https://api.deepseek.com",
      thinkingEnabled: false,
      autoThinkingEnabled: false
    }),
    getResolvedSettings: () => ({}),
    renderMarkdown: (text) => text,
    onAssistantMessage: () => {}
  });
}

class APIUserAbortError extends Error {}

function createChatResponse(content: string, usage: Record<string, unknown>): unknown {
  return {
    choices: [{ message: { content } }],
    usage
  };
}

async function* createChatStreamResponse(chunks: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
