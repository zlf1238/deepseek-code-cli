import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

// ── 索引状态管理 ────────────────────────────────────────
const MAX_INDEX_AGE_MS = 30 * 60 * 1000; // 30分钟过期
const INDEX_LOCK = new Map<string, Promise<{ ok: boolean; error?: string }>>();

function getGitnexusDir(projectRoot: string): string {
  return path.join(projectRoot, ".gitnexus");
}

function isIndexed(projectRoot: string): boolean {
  return fs.existsSync(getGitnexusDir(projectRoot));
}

function shouldReindex(projectRoot: string): boolean {
  const metaPath = path.join(getGitnexusDir(projectRoot), "meta.json");
  if (!fs.existsSync(metaPath)) return true;
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const meta = JSON.parse(raw) as { indexedAt?: string };
    if (meta.indexedAt) {
      const indexedTime = new Date(meta.indexedAt).getTime();
      if (!isNaN(indexedTime)) {
        return Date.now() - indexedTime > MAX_INDEX_AGE_MS;
      }
    }
  } catch {
    // 解析失败则触发重新索引
  }
  return true;
}

// ── 自动索引 (借鉴 RepoMap: 零配置体验) ──────────────────
async function ensureIndex(
  projectRoot: string,
  context: ToolExecutionContext
): Promise<{ ok: boolean; error?: string }> {
  if (isIndexed(projectRoot) && !shouldReindex(projectRoot)) {
    return { ok: true };
  }

  // 避免并发索引同一项目
  const existing = INDEX_LOCK.get(projectRoot);
  if (existing) return existing;

  const pid = `gitnexus-index`;
  context.onProcessStart?.(pid, "gitnexus analyze (indexing codebase for knowledge graph)");

  const promise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn(
      "npx",
      ["-y", "gitnexus@latest", "analyze", "--skip-embeddings", projectRoot],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000
      }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      context.onProcessExit?.(pid);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const errMsg = stderr.slice(0, 500).replace(/\n/g, " ");
        resolve({ ok: false, error: `GitNexus indexing failed (exit ${code}): ${errMsg}` });
      }
    });

    child.on("error", (err) => {
      context.onProcessExit?.(pid);
      resolve({ ok: false, error: `GitNexus spawn failed: ${err.message}` });
    });
  });

  INDEX_LOCK.set(projectRoot, promise);
  try {
    return await promise;
  } finally {
    INDEX_LOCK.delete(projectRoot);
  }
}

// ── MCP JSON-RPC 客户端 (一次性调用模式) ──────────────────
interface MCPMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class GitnexusMCPOneShot {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;
  private nextId = 0;
  private initialized = false;
  private initResolve: (() => void) | null = null;
  private pendingType: 'tool' | 'resource' = 'tool';

  constructor(private projectRoot: string) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingType = 'tool';

      this.proc = spawn("npx", ["-y", "gitnexus@latest", "mcp"], {
        cwd: this.projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000
      });

      let stderrAcc = "";
      this.proc.stderr?.on("data", (chunk: Buffer) => {
        stderrAcc += chunk.toString();
      });

      this.proc.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.proc.on("error", (err) => {
        reject(new Error(`GitNexus MCP spawn failed: ${err.message}`));
      });

      this.proc.on("close", (code) => {
        if (this.pendingReject) {
          const msg = stderrAcc.trim() || `GitNexus MCP exited with code ${code}`;
          reject(new Error(msg || "GitNexus MCP closed unexpectedly"));
        }
      });

      // 初始化阶段的 Promise 链
      this.initResolve = () => {
        // 初始化完成后发送实际工具调用
        this.sendRequest("tools/call", { name, arguments: args });
      };

      // 第一步：发送 initialize
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "deepseek-code-cli", version: "1.0.0" }
      });
    });
  }

  async readResource(uri: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingType = 'resource';

      this.proc = spawn("npx", ["-y", "gitnexus@latest", "mcp"], {
        cwd: this.projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000
      });

      let stderrAcc = "";
      this.proc.stderr?.on("data", (chunk: Buffer) => {
        stderrAcc += chunk.toString();
      });

      this.proc.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.proc.on("error", (err) => {
        reject(new Error(`GitNexus MCP spawn failed: ${err.message}`));
      });

      this.proc.on("close", (code) => {
        if (this.pendingReject) {
          const msg = stderrAcc.trim() || `GitNexus MCP exited with code ${code}`;
          reject(new Error(msg || "GitNexus MCP closed unexpectedly"));
        }
      });

      // 初始化阶段的 Promise 链
      this.initResolve = () => {
        // 初始化完成后发送 resources/read
        this.sendRequest("resources/read", { uri });
      };

      // 第一步：发送 initialize
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "deepseek-code-cli", version: "1.0.0" }
      });
    });
  }

  private sendRequest(method: string, params: Record<string, unknown>): void {
    const id = this.nextId++;
    const msg: MCPMessage = { jsonrpc: "2.0", id, method, params };
    const line = `${JSON.stringify(msg)}\n`;
    this.proc?.stdin?.write(line);
  }

  private processBuffer(): void {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg: MCPMessage = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // 忽略非 JSON 行
      }
    }
  }

  private handleMessage(msg: MCPMessage): void {
    if (msg.error) {
      const err = new Error(`GitNexus MCP error: ${msg.error.message} (code ${msg.error.code})`);
      this.pendingReject?.(err);
      this.cleanup();
      return;
    }

    if (msg.method) {
      // 服务端通知 (如 progress)
      return;
    }

    // 响应消息
    if (!this.initialized) {
      // initialize 响应
      if (msg.id === 0 && msg.result !== undefined) {
        this.initialized = true;
        // 发送 initialized 通知
        const notif: MCPMessage = {
          jsonrpc: "2.0",
          method: "notifications/initialized"
        };
        this.proc?.stdin?.write(`${JSON.stringify(notif)}\n`);
        this.initResolve?.();
      }
    } else {
      // 工具调用或资源读取响应
      if (msg.result !== undefined && this.pendingResolve) {
        if (this.pendingType === 'resource') {
          const output = this.extractResourceResult(msg.result);
          this.pendingResolve(output);
        } else {
          const output = this.extractToolResult(msg.result);
          this.pendingResolve(output);
        }
        this.cleanup();
      }
    }
  }

  private extractToolResult(result: unknown): string {
    if (!result || typeof result !== "object") {
      return String(result ?? "");
    }
    const r = result as Record<string, unknown>;

    // MCP tools/call 响应格式: { content: [{ type: "text", text: "..." }] }
    const content = r.content;
    if (Array.isArray(content)) {
      const texts = content
        .map((item: unknown) => {
          if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
            return (item as { text?: string }).text ?? "";
          }
          return "";
        })
        .filter(Boolean);
      return texts.join("\n");
    }

    return JSON.stringify(result, null, 2);
  }

  private extractResourceResult(result: unknown): string {
    if (!result || typeof result !== "object") {
      return String(result ?? "");
    }
    const r = result as Record<string, unknown>;

    // MCP resources/read 响应格式: { contents: [{ type: "text", text: "..." }] }
    const contents = r.contents;
    if (Array.isArray(contents)) {
      const texts = contents
        .map((item: unknown) => {
          if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
            return (item as { text?: string }).text ?? "";
          }
          return "";
        })
        .filter(Boolean);
      return texts.join("\n");
    }

    return JSON.stringify(result, null, 2);
  }

  private cleanup(): void {
    this.pendingResolve = null;
    this.pendingReject = null;
    this.initResolve = null;
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.stdin?.end();
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }
}

// ── Repo 名称缓存 ─────────────────────────────────────
const repoNameCache = new Map<string, string>();

async function getRepoName(projectRoot: string): Promise<string> {
  const cached = repoNameCache.get(projectRoot);
  if (cached) return cached;

  const client = new GitnexusMCPOneShot(projectRoot);
  const raw = await client.callTool("list_repos", {});

  let repos: Array<{ name?: string; path?: string }> = [];
  try {
    repos = JSON.parse(raw);
  } catch {
    // 如果解析失败，使用目录名作为 repo 名称
    const fallback = path.basename(projectRoot);
    repoNameCache.set(projectRoot, fallback);
    return fallback;
  }

  const normalizedRoot = path.resolve(projectRoot);
  const match = repos.find((r) => r.path && path.resolve(r.path) === normalizedRoot);
  const repoName = match?.name || path.basename(projectRoot);
  repoNameCache.set(projectRoot, repoName);
  return repoName;
}

// ── Token 预算感知截断 (借鉴 RepoMap 的 token_count + max_map_tokens) ─
function truncateByCharLimit(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const skipped = text.length - maxChars;
  return `${head}\n\n… (truncated ${skipped} chars, use max_chars to adjust)\n\n${tail}`;
}

// ── 确保已索引的通用包装 ──────────────────────────────
async function withIndex(
  context: ToolExecutionContext,
  fn: () => Promise<ToolExecutionResult>
): Promise<ToolExecutionResult> {
  const indexResult = await ensureIndex(context.projectRoot, context);
  if (!indexResult.ok) {
    // 降级：重新索引失败但已有索引数据时，继续使用现有索引
    if (isIndexed(context.projectRoot)) {
      // 继续执行，使用现有（可能过期但可用的）索引
    } else {
      return { ok: false, name: "", error: indexResult.error };
    }
  }
  return fn();
}

// ── 5 个 Handler ──────────────────────────────────────

export async function handleGitnexusQuery(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, name: "gitnexus_query", error: 'Missing required "query" string.' };
  }

  return withIndex(context, async () => {
    try {
      const client = new GitnexusMCPOneShot(context.projectRoot);
      const raw = await client.callTool("query", { query });
      const maxChars = typeof args.max_chars === "number" ? args.max_chars : 8000;
      return {
        ok: true,
        name: "gitnexus_query",
        output: truncateByCharLimit(raw, maxChars),
        metadata: { truncated: raw.length > maxChars }
      };
    } catch (e) {
      return { ok: false, name: "gitnexus_query", error: String(e) };
    }
  });
}

export async function handleGitnexusContext(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return { ok: false, name: "gitnexus_context", error: 'Missing required "name" string.' };
  }

  return withIndex(context, async () => {
    try {
      const client = new GitnexusMCPOneShot(context.projectRoot);
      const raw = await client.callTool("context", { name });
      const maxChars = typeof args.max_chars === "number" ? args.max_chars : 6000;
      return {
        ok: true,
        name: "gitnexus_context",
        output: truncateByCharLimit(raw, maxChars),
        metadata: { truncated: raw.length > maxChars }
      };
    } catch (e) {
      return { ok: false, name: "gitnexus_context", error: String(e) };
    }
  });
}

export async function handleGitnexusImpact(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  if (!target) {
    return { ok: false, name: "gitnexus_impact", error: 'Missing required "target" path.' };
  }

  return withIndex(context, async () => {
    try {
      const params: Record<string, unknown> = { path: target };
      if (typeof args.symbol === "string" && args.symbol.trim()) {
        params.symbol = args.symbol.trim();
      }
      const client = new GitnexusMCPOneShot(context.projectRoot);
      const raw = await client.callTool("impact", params);
      return { ok: true, name: "gitnexus_impact", output: raw };
    } catch (e) {
      return { ok: false, name: "gitnexus_impact", error: String(e) };
    }
  });
}

export async function handleGitnexusClusters(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return withIndex(context, async () => {
    try {
      const repoName = await getRepoName(context.projectRoot);
      const client = new GitnexusMCPOneShot(context.projectRoot);
      let uri: string;
      if (typeof args.cluster === "string" && args.cluster.trim()) {
        uri = `gitnexus://repo/${repoName}/cluster/${args.cluster.trim()}`;
      } else {
        uri = `gitnexus://repo/${repoName}/clusters`;
      }
      const raw = await client.readResource(uri);
      return { ok: true, name: "gitnexus_clusters", output: raw };
    } catch (e) {
      return { ok: false, name: "gitnexus_clusters", error: String(e) };
    }
  });
}

export async function handleGitnexusProcesses(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return withIndex(context, async () => {
    try {
      const repoName = await getRepoName(context.projectRoot);
      const client = new GitnexusMCPOneShot(context.projectRoot);
      let uri: string;
      if (typeof args.process === "string" && args.process.trim()) {
        uri = `gitnexus://repo/${repoName}/process/${args.process.trim()}`;
      } else {
        uri = `gitnexus://repo/${repoName}/processes`;
      }
      const raw = await client.readResource(uri);
      return { ok: true, name: "gitnexus_processes", output: raw };
    } catch (e) {
      return { ok: false, name: "gitnexus_processes", error: String(e) };
    }
  });
}

// ── Session 初始化用：后台异步索引 ──────────────────────
export function ensureGitnexusIndexAsync(projectRoot: string): void {
  // 后台静默索引，不阻塞会话启动
  if (isIndexed(projectRoot) && !shouldReindex(projectRoot)) return;

  const child = spawn(
    "npx",
    ["-y", "gitnexus@latest", "analyze", "--skip-embeddings", projectRoot],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: "ignore",
      timeout: 120_000
    }
  );

  child.on("error", () => {
    // 静默失败——索引失败不影响工具使用 (每次调用时仍会尝试)
  });
}
