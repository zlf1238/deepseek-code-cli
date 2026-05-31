/**
 * pi TUI 版本的应用主组件。
 * 替代 App.tsx 的核心功能：视图切换、消息流、输入处理、命令路由。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { TUI, Container, isFocusable } from "../tui/tui";
import { SelectList, type SelectItem } from "../tui/components/select-list";
import { Text } from "../tui/components/text";
import { Spacer } from "../tui/components/spacer";
import { Box } from "../tui/components/box";
import { ProcessTerminal } from "../tui/terminal";
import { createWelcomeScreen } from "./PiWelcomeScreen";
import { createMessageView, type MessageRole } from "./PiMessageView";
import { PiPromptInput, type PromptSubmission, type SlashContext } from "./PiPromptInput";
import { PiSessionList, formatTimestamp } from "./PiSessionList";
import { PiQuestionList, type QuestionItem } from "./PiQuestionList";
import { PiAskUserQuestionPrompt } from "./PiAskUserQuestionPrompt";
import { createSlashCommandList } from "./PiSlashCommandList";
import { createHelpOverlay } from "./PiHelpOverlay";
import { Theme } from "../tui/ThemeAdapter";
import { buildStatusLine } from "./statusLine";
import { buildLoadingText } from "./loadingText";
import { buildCompletionSummary } from "./completionSummary";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessage,
  type SkillInfo,
  type UserPromptContent,
  getTotalTokens,
  getPromptTokens,
  getCompletionTokens,
  getPromptCacheHitTokens,
  getPromptCacheMissTokens,
} from "../session";
import type { AskUserQuestionItem, AskUserQuestionAnswers } from "./askUserQuestion";
import {
  resolveSettings,
  getAvailableModelNames,
  updateActiveModelInSettings,
  updateThinkingConfigInSettings,
  updateVerboseModeInSettings,
  updateModeInSettings,
  type DeepcodingSettings,
  type ResolvedDeepcodingSettings, type ReasoningEffort,
} from "../settings";
import { filterSlashCommands, buildSlashCommands, findExactSlashCommand, type SlashCommandItem } from "./slashCommands";
import { findPendingAskUserQuestion, formatAskUserQuestionAnswers } from "./askUserQuestion";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

/** 应用视图 */
type View = "welcome" | "chat" | "session-list" | "question-list" | "ask-question";

/** 消息条目 */
interface Message {
  role: MessageRole;
  content: string;
  timestamp: number;
  /** 对应 SessionMessage.id，用于流式更新时匹配消息 */
  messageId?: string;
  /** 原始 SessionMessage 的 meta 信息（用于工具消息渲染） */
  meta?: {
    asThinking?: boolean;
    isSummary?: boolean;
    isStepIndicator?: boolean;
    stepDescription?: string;
    function?: unknown;
    paramsMd?: string;
    resultMd?: string;
    statusColor?: string;
    isToolGroup?: boolean;
    /** 流式输出开始标记 */
    isStreamStart?: boolean;
    /** 流式输出增量更新标记 */
    isStreamDelta?: boolean;
  };
}

export class PiApp {
  private tui: TUI;
  private terminal: ProcessTerminal;
  private root: Container;
  private view: View = "welcome";
  /** 进入 question-list 前所在的视图（Esc 时据此决定返回 chat 还是 session-list） */
  private previousView: View = "welcome";
  private messages: Message[] = [];
  private promptInput: PiPromptInput;
  private sessionList: PiSessionList;
  private questionList: PiQuestionList;
  /** Alt+Q 或 /resume 选中会话后暂存，供 question-list 使用 */
  private pendingSessionId: string | null = null;
  private askPrompt: PiAskUserQuestionPrompt;
  private settings!: ResolvedDeepcodingSettings;
  private skills: SkillInfo[] = [];
  private model: string;
  private projectRoot: string;
  private sessionManager!: SessionManager;
  private busy = false;
  private statusLine = "";
  private errorLine: string | null = null;
  private sessions: SessionEntry[] = [];
  private verboseMode = false;

  /** P1: Ctrl+D 双击退出 */
  private lastCtrlDAt = 0;
  private ctrlDWarningTimeout: ReturnType<typeof setTimeout> | null = null;

  /** P1: 终端标题栏 & 响铃 */
  private prevBusy = false;
  private promptStartTime = 0;
  private streamProgress: { phase: string; startedAt: string; estimatedTokens?: number; formattedTokens?: string } | null = null;

  /** 斜杠命令菜单状态 */
  private slashItems: SlashCommandItem[] = [];
  private slashMenuIndex = 0;
  private showSlashMenu = false;
  /** 防止菜单选择/关闭后 handleSlashChange 重新打开菜单 */
  private slashMenuSuppressed = false;
  /** 帮助浮层是否可见 */
  private showHelpOverlay = false;
  /** 已关闭的 AskUserQuestion messageId，防止取消后重复弹出 */
  private dismissedQuestionIds = new Set<string>();
  /** 当前待回答的 question messageId（取消时加入 dismissedQuestionIds） */
  private pendingAskMessageId: string | null = null;
  /** 后台运行进程快照，用于状态行展示 */
  private runningProcesses: SessionEntry["processes"] = null;
  /** 内联选择菜单（/model、/thinking、/skills 的交互菜单） */
  private inlineSelectKind: "model" | "thinking" | "skills" | null = null;
  private inlineSelectItems: SelectItem[] = [];
  private inlineSelectIndex = 0;
  /** 通过 /skills 菜单选中的技能，将在下次提交 prompt 时附加 */
  private selectedSkills: SkillInfo[] = [];

  constructor(projectRoot: string, model: string) {
    this.projectRoot = projectRoot;
    this.model = model;

    this.terminal = new ProcessTerminal();
    this.tui = new TUI(this.terminal);
    this.root = new Container();

    this.promptInput = new PiPromptInput();
    const listMaxVisible = Math.max(5, this.terminal.rows - 6);
    const listMaxWidth = this.terminal.columns;
    this.sessionList = new PiSessionList(listMaxVisible, listMaxWidth);
    this.questionList = new PiQuestionList(listMaxVisible, listMaxWidth);
    this.askPrompt = new PiAskUserQuestionPrompt();

    this.setupCallbacks();
  }

  /** 启动应用 */
  async start(): Promise<void> {
    // 加载设置
    try {
      this.settings = resolveSettings(
        this.readSettings(),
        { model: this.model, baseURL: DEFAULT_BASE_URL }
      );
      this.model = this.settings.model;
      this.verboseMode = this.readSettings()?.verboseMode ?? false;
    } catch {
      // 使用默认设置
      this.settings = {
        apiKey: undefined,
        baseURL: DEFAULT_BASE_URL,
        model: this.model,
        mode: "auto",
        thinkingEnabled: false,
        reasoningEffort: "max",
        notify: undefined,
        webSearchTool: undefined,
        pricing: {
          inputPricePerMillion: 0,
          outputPricePerMillion: 0,
          inputCacheHitPricePerMillion: 0,
          inputCacheMissPricePerMillion: 0,
        },
        autoSwitch: {
          enabled: true,
          maxPaybackRounds: 8,
          estimatedOutputPerRound: 8000,
          estimatedInputPerRound: 500,
          cacheHitRate: 0.5,
        },
      };
    }

    // 创建 SessionManager
    this.sessionManager = new SessionManager({
      projectRoot: this.projectRoot,
      createOpenAIClient: (overrideModel?: string) =>
        this.createOpenAIClient(overrideModel),
      getResolvedSettings: () => ({ webSearchTool: this.settings.webSearchTool }),
      renderMarkdown: (text) => text,
      onAssistantMessage: (message: SessionMessage) => {
        this.onAssistantMessageCallback(message);
      },
      onSessionEntryUpdated: (entry: SessionEntry) => {
        this.statusLine = buildStatusLine(entry, this.model, this.settings.pricing);
        this.runningProcesses = entry.processes;

        // 检测 AI 发起的问题弹窗（AskUserQuestion / ask_choice）
        if (entry.status === "waiting_for_user") {
          const sessionId = this.sessionManager.getActiveSessionId();
          if (sessionId) {
            const sessionMessages = this.sessionManager.listSessionMessages(sessionId);
            const pending = findPendingAskUserQuestion(sessionMessages, "waiting_for_user");
            if (pending && !this.dismissedQuestionIds.has(pending.messageId)) {
              this.pendingAskMessageId = pending.messageId;
              this.renderAskQuestion(pending.questions);
              return;
            }
          }
        }
      },
      onLlmStreamProgress: (progress) => {
        if (progress.phase === "end") {
          this.streamProgress = null;
        } else {
          this.streamProgress = progress;
        }
        if (this.view === "chat") this.renderChat();  // 实时更新 loading 文本
      },
    });

    // 刷新 skills
    try {
      this.skills = await this.sessionManager.listSkills();
    } catch {
      // ignore
    }

    // 恢复上一个会话（如有）
    const sessionList = this.sessionManager.listSessions();
    this.sessions = sessionList;
    if (sessionList.length > 0) {
      const latest = sessionList[0];
      this.sessionManager.setActiveSessionId(latest.id);
      this.loadMessagesFromSession(latest.id);
      this.statusLine = buildStatusLine(latest, this.model, this.settings.pricing);
    }

    this.renderWelcome();
    this.tui.addChild(this.root);

    this.terminal.start(
      (data: string) => this.handleInput(data),
      () => this.tui.requestRender()
    );

    this.terminal.hideCursor();
    this.tui.requestRender();
  }

  /** 停止应用 */
  stop(): void {
    this.stopLoadingTimer();
    this.terminal.showCursor();
    this.setTerminalTitle("DeepSeek Code");
    this.tui.stop();
  }

  // ── 视图渲染 ──

  private renderWelcome(): void {
    this.view = "welcome";
    this.root.clear();
    this.slashMenuSuppressed = false;

    // 如果有已加载的消息（从上次会话恢复），直接展示聊天视图
    if (this.messages.length > 0) {
      this.renderChat();
    } else {
      this.root.addChild(createWelcomeScreen(
        this.projectRoot, this.settings, this.skills, this.model, this.terminal.columns, this.verboseMode,
      ));
      // 内联选择菜单（/model、/thinking、/skills）
      if (this.inlineSelectKind !== null && this.inlineSelectItems.length > 0) {
        const inlineList = new SelectList({
          maxVisible: 8,
          theme: {
            selectedPrefix: Theme.selectedPrefix,
            selectedText: Theme.selectedText,
            description: Theme.description,
            scrollInfo: Theme.dimText,
            noMatch: Theme.dimText,
          },
        });
        inlineList.setItems(this.inlineSelectItems);
        inlineList.setSelectedIndex(this.inlineSelectIndex);
        this.root.addChild(inlineList);
      }
      // 渲染斜杠命令菜单
      if (this.showSlashMenu && this.slashItems.length > 0) {
        this.root.addChild(createSlashCommandList(this.slashItems, this.slashMenuIndex));
      }
      // 帮助浮层
      if (this.showHelpOverlay) {
        this.root.addChild(createHelpOverlay());
      }
      this.root.addChild(this.promptInput);
      if (isFocusable(this.promptInput)) this.tui.setFocus(this.promptInput);
    }
  }

  private renderChat(): void {
    this.view = "chat";
    this.root.clear();
    this.slashMenuSuppressed = false;

    // 直接把所有消息视图加入 root（利用终端原生滚动缓冲区）
    // P2: 工具调用归组（非 verbose 模式下，连续 ≥3 个 tool 消息折叠为一行摘要）
    if (this.verboseMode) {
      for (const msg of this.messages) {
        if (!this.verboseMode && msg.meta?.asThinking) continue;
        this.root.addChild(createMessageView(msg.content, msg.role, this.terminal.columns, msg.meta));
      }
    } else {
      let i = 0;
      while (i < this.messages.length) {
        const msg = this.messages[i];
        // 跳过思考过程
        if (msg.meta?.asThinking) { i++; continue; }

        // 检测连续 tool 消息（有 function/paramsMd 标记）
        if (msg.meta?.function || msg.meta?.paramsMd) {
          let toolCount = 0;
          let j = i;
          const toolNames: string[] = [];
          while (j < this.messages.length) {
            const m = this.messages[j];
            if (!m.meta?.function && !m.meta?.paramsMd) break;
            const fn = m.meta.function as { name?: string } | undefined;
            if (fn?.name) toolNames.push(fn.name);
            toolCount++;
            j++;
          }
          if (toolCount >= 3) {
            // 归组为一行摘要
            const uniqueNames = [...new Set(toolNames)];
            const nameStr = uniqueNames.length <= 3
              ? uniqueNames.join(" + ")
              : `${uniqueNames.slice(0, 3).join(" + ")} +${uniqueNames.length - 3} more`;
            this.root.addChild(createMessageView(
              `🔍 ${nameStr} (${toolCount} 个工具)`,
              "assistant", this.terminal.columns,
              { isToolGroup: true },
            ));
            i = j;
          } else {
            this.root.addChild(createMessageView(msg.content, msg.role, this.terminal.columns, msg.meta));
            i++;
          }
        } else {
          this.root.addChild(createMessageView(msg.content, msg.role, this.terminal.columns, msg.meta));
          i++;
        }
      }
    }

    // 状态行（Ink 风格：token 用量 + 缓存命中 + 费用）
    if (this.busy) {
      const loadingText = buildLoadingText({
        progress: this.streamProgress as any,
        processes: this.runningProcesses,
        now: Date.now(),
      });
      this.root.addChild(new Text(`  ⏳ ${loadingText}`, 0, 0, Theme.statusText));
    } else if (this.statusLine) {
      this.root.addChild(new Text(`  ${this.statusLine}`, 0, 0, Theme.statusText));
    }
    if (this.errorLine) {
      this.root.addChild(new Text(`  Error: ${this.errorLine}`, 0, 0, Theme.errorText));
    }

    // 内联选择菜单（/model、/thinking、/skills）
    if (this.inlineSelectKind !== null && this.inlineSelectItems.length > 0) {
      const inlineList = new SelectList({
        maxVisible: 8,
        theme: {
          selectedPrefix: Theme.selectedPrefix,
          selectedText: Theme.selectedText,
          description: Theme.description,
          scrollInfo: Theme.dimText,
          noMatch: Theme.dimText,
        },
      });
      inlineList.setItems(this.inlineSelectItems);
      inlineList.setSelectedIndex(this.inlineSelectIndex);
      this.root.addChild(inlineList);
    }

    // 斜杠命令菜单
    if (this.showSlashMenu && this.slashItems.length > 0) {
      this.root.addChild(createSlashCommandList(this.slashItems, this.slashMenuIndex));
    }

    // 帮助浮层
    if (this.showHelpOverlay) {
      this.root.addChild(createHelpOverlay());
    }

    // 输入框
    this.root.addChild(this.promptInput);
    if (isFocusable(this.promptInput)) this.tui.setFocus(this.promptInput);

    // 每次 renderChat 后刷新终端（确保 AI 流式消息即时显示）
    this.tui.requestRender();
  }

  private renderSessionList(sessions: SessionEntry[]): void {
    this.view = "session-list";
    this.root.clear();

    // P3-2: 会话列表头部信息栏
    this.root.addChild(new Text(Theme.boldText(`  会话列表 (${sessions.length})`), 0, 0));
    this.root.addChild(new Text(Theme.dimText(`  ${this.sessionList.modeLabel}`), 0, 0));
    this.root.addChild(new Spacer(1));

    this.sessionList.setSessions(sessions);
    this.root.addChild(this.sessionList);
  }

  /** 渲染提问列表视图：列出会话中所有用户提问（role === "user"） */
  private renderQuestionList(sessionId: string): void {
    this.view = "question-list";
    this.root.clear();

    // 加载该会话所有消息，使用与 loadMessagesFromSession 相同的过滤逻辑
    const allMessages = this.sessionManager.listSessionMessages(sessionId);
    const filtered = allMessages.filter(
      (m) => m.visible && (m.role !== "system" || m.meta?.isSummary)
    );
    const questions: QuestionItem[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      // 只记录 user 角色的提问（filtered 已排除纯系统消息）
      if (m.role !== "user") continue;
      const content = (m.content || "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
      const maxLen = 55;
      const display = content.length <= maxLen ? content : `${content.slice(0, maxLen)}…`;
      questions.push({
        messageIndex: i,
        displayIndex: questions.length + 1,
        content: display || "(无内容)",
        fullContent: content || "(无内容)",
        timestamp: formatTimestamp(m.createTime),
      });
    }

    // 会话标题
    const entry = this.sessionManager.getSession(sessionId);
    const title = entry?.summary
      ? entry.summary.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 55)
      : sessionId;
    this.root.addChild(new Text(Theme.boldText("  选择要跳转的提问"), 0, 0));
    this.root.addChild(new Text(Theme.dimText(`  对话: ${title}`), 0, 0));
    this.root.addChild(new Spacer(1));

    this.questionList.setQuestions(questions);
    this.root.addChild(this.questionList);

    // 底部操作提示：根据来源决定返回文案
    const backLabel = this.previousView === "session-list"
      ? "Esc/b: 返回对话列表"
      : "Esc/b: 返回对话";
    this.root.addChild(new Text(
      Theme.dimText(`  ↑/↓: 切换 · Enter: 跳转到此提问 · ${backLabel}`), 0, 0,
    ));
  }

  private renderAskQuestion(questions: AskUserQuestionItem[]): void {
    this.view = "ask-question";
    this.root.clear();
    this.askPrompt.setQuestions(questions);
    this.root.addChild(this.askPrompt);
  }

  // ── 输入路由 ──

  private handleInput(data: string): void {
    if (data === "\x03") { this.stop(); return; } // Ctrl+C

    // P1: Ctrl+D 双击退出
    if (data === "\x04") {
      const now = Date.now();
      if (now - this.lastCtrlDAt < 1500) {
        this.stop();
        return;
      }
      this.lastCtrlDAt = now;
      this.errorLine = "再按一次 Ctrl+D 退出";
      if (this.ctrlDWarningTimeout) clearTimeout(this.ctrlDWarningTimeout);
      this.ctrlDWarningTimeout = setTimeout(() => {
        if (this.errorLine === "再按一次 Ctrl+D 退出") {
          this.errorLine = null;
          this.tui.requestRender();
        }
      }, 1500);
      this.tui.requestRender();
      return;
    }

    // P2: Ctrl+H / ? 切换帮助
    if (data === "?" || data === "\x08h" || (data.length === 2 && data[0] === "\x08" && data[1] === "h")) {
      // 简单处理：在 Pi 版中显示帮助面板作为消息
      this.toggleHelp();
      return;
    }

    // 帮助浮层可见时，Esc 关闭
    if (data === "\x1b" && this.showHelpOverlay) {
      this.showHelpOverlay = false;
      this.renderChat();
      return;
    }

    // P0: Esc 中断生成（chat 视图下）
    if (data === "\x1b" && this.view === "chat" && this.busy && !this.showSlashMenu) {
      this.interrupt();
      return;
    }

    // P3-5: 删除确认模式
    if (this.pendingDeleteIds) {
      if (data === "\r" || data === "\n") {
        this.executeDelete(this.pendingDeleteIds);
        this.pendingDeleteIds = null;
        this.renderSessionList(this.sessions);
      } else if (data === "\x1b") {
        this.pendingDeleteIds = null;
        this.renderSessionList(this.sessions);
      }
      return;
    }

    const inChat = this.view === "chat" || this.view === "welcome";

    switch (this.view) {
      case "welcome":
      case "chat":
        // 内联选择菜单导航（/model、/thinking、/skills）
        if (this.inlineSelectKind !== null) {
          if (data === "\x1b[A") {
            // 上
            this.inlineSelectIndex = this.inlineSelectIndex === 0
              ? this.inlineSelectItems.length - 1
              : this.inlineSelectIndex - 1;
            if (this.view === "chat") this.renderChat();
            else if (this.view === "welcome") this.renderWelcome();
            this.tui.requestRender();
            return;
          } else if (data === "\x1b[B") {
            // 下
            this.inlineSelectIndex = this.inlineSelectIndex === this.inlineSelectItems.length - 1
              ? 0
              : this.inlineSelectIndex + 1;
            if (this.view === "chat") this.renderChat();
            else if (this.view === "welcome") this.renderWelcome();
            this.tui.requestRender();
            return;
          } else if (data === "\r" || data === "\n") {
            // Enter: 选择当前项
            const selectedItem = this.inlineSelectItems[this.inlineSelectIndex];
            if (selectedItem) {
              if (this.inlineSelectKind === "model") {
                this.handleInlineModelSelect(selectedItem.value);
              } else if (this.inlineSelectKind === "thinking") {
                this.handleInlineThinkingSelect(selectedItem.value);
              } else if (this.inlineSelectKind === "skills") {
                this.handleInlineSkillToggle(selectedItem.value);
              }
            }
            return;
          } else if (data === "\x1b") {
            // Esc: 关闭菜单
            this.closeInlineSelect();
            return;
          } else {
            // 其他按键：传给 promptInput
            this.promptInput.handleInput(data);
            if (this.view === "chat") this.renderChat();
            else if (this.view === "welcome") this.renderWelcome();
            return;
          }
        }

        // 斜杠菜单导航
        if (this.showSlashMenu) {
          if (data === "\x1b[A") {
            // 上
            this.slashMenuIndex = (this.slashMenuIndex - 1 + this.slashItems.length) % this.slashItems.length;
            if (this.view === "chat") this.renderChat();
            else if (this.view === "welcome") this.renderWelcome();
            this.tui.requestRender();
            return;
          } else if (data === "\x1b[B") {
            // 下
            this.slashMenuIndex = (this.slashMenuIndex + 1) % this.slashItems.length;
            if (this.view === "chat") this.renderChat();
            else if (this.view === "welcome") this.renderWelcome();
            this.tui.requestRender();
            return;
          } else if (data === "\r" || data === "\n") {
            // Enter: 直接执行选中的斜杠命令
            const allItems = buildSlashCommands(this.skills);
            const filteredItems = filterSlashCommands(allItems, this.promptInput.value);
            const selectedItem = filteredItems[this.slashMenuIndex];
            if (selectedItem) {
              this.showSlashMenu = false;
              this.slashItems = [];
              this.promptInput.clear();
              this.slashMenuSuppressed = true;
              this.handleSlashCommandSelection(selectedItem);
            }
            this.tui.requestRender();
            return;
          } else if (data === "\x1b") {
            // Esc: 关闭菜单
            this.showSlashMenu = false;
            this.slashItems = [];
            this.slashMenuSuppressed = true;
          } else {
            // 其他输入委托给 Input
            this.promptInput.handleInput(data);
          }
        } else {
          // Alt+Q: 查看当前会话的提问列表
          if (data === "\x1bq" || data === "\x1bQ") {
            const activeId = this.sessionManager.getActiveSessionId();
            if (activeId && this.messages.length > 0) {
              this.previousView = this.view;
              this.pendingSessionId = activeId;
              this.renderQuestionList(activeId);
              return;
            }
          }
          this.promptInput.handleInput(data);
        }
        this.checkSlashMenu();
        break;
      case "session-list":
        this.sessionList.handleInput(data);
        break;
      case "question-list":
        this.questionList.handleInput(data);
        break;
      case "ask-question":
        this.askPrompt.handleInput(data);
        break;
    }

    this.tui.requestRender();
  }

  // ── 回调设置 ──

  private setupCallbacks(): void {
    this.promptInput.onSubmit = (sub) => this.handlePromptSubmit(sub);
    this.promptInput.onCancel = () => {
      if (this.busy) {
        this.interrupt();
      } else {
        this.stop();
      }
    };
    this.promptInput.onSlashChange = (ctx) => this.handleSlashChange(ctx);

    this.sessionList.onSelect = (id) => {
      // 先进入提问列表，而非直接进入 chat
      this.previousView = "session-list";
      this.pendingSessionId = id;
      this.renderQuestionList(id);
    };
    this.sessionList.onCancel = () => this.renderChat();
    this.questionList.onSelect = (messageIndex) => {
      const sessionId = this.pendingSessionId!;
      this.sessionManager.setActiveSessionId(sessionId);
      this.loadMessagesFromSession(sessionId, messageIndex);
      const entry = this.sessionManager.getSession(sessionId);
      if (entry) {
        this.statusLine = buildStatusLine(entry, this.model, this.settings.pricing);
      }
      this.renderChat();
    };
    this.questionList.onCancel = () => {
      if (this.previousView === "session-list") {
        this.sessions = this.sessionManager.listSessions();
        this.renderSessionList(this.sessions);
      } else {
        this.renderChat();
      }
    };
    this.sessionList.onDelete = (sessionIds) => {
      // P3-5: 删除确认 — 只有一个会话时需要确认
      if (sessionIds.length === 1) {
        this.showDeleteConfirm(sessionIds);
      } else {
        this.executeDelete(sessionIds);
      }
    };

    this.askPrompt.onSubmit = (answers) => {
      const text = formatAskUserQuestionAnswers(answers);
      this.addMessage("user", text);
      this.renderChat();
      // 将答案提交给 LLM
      const prompt: UserPromptContent = { text };
      this.busy = true;
      this.errorLine = null;
      this.setBusy(true);
      this.sessionManager.handleUserPrompt(prompt)
        .then(() => {
          const sessionId = this.sessionManager.getActiveSessionId();
          if (sessionId) this.loadMessagesFromSession(sessionId);
          this.renderChat();
          this.sessions = this.sessionManager.listSessions();
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          this.errorLine = msg;
          this.renderChat();
        })
        .finally(() => {
          this.setBusy(false);
          this.renderChat();
        });
    };
    this.askPrompt.onCancel = () => {
      if (this.pendingAskMessageId) {
        this.dismissedQuestionIds.add(this.pendingAskMessageId);
        this.pendingAskMessageId = null;
      }
      this.renderChat();
    };
  }

  private handlePromptSubmit(sub: PromptSubmission): void {
    const text = sub.text;
    const trimmed = text.trim();
    if (!trimmed) return;

    // 斜杠命令路由
    if (trimmed.startsWith("/")) {
      const allItems = buildSlashCommands(this.skills);
      const exact = findExactSlashCommand(allItems, trimmed);
      if (exact) {
        this.showSlashMenu = false;
        this.slashItems = [];
        this.promptInput.clear();
        this.handleSlashCommandSelection(exact);
        return;
      }
      // 未识别的斜杠命令 → 发送给 LLM
    }

    if (this.busy) return;

    // 普通消息 — 调用 LLM
    this.addMessage("user", trimmed);
    this.promptInput.clear();

    const prompt: UserPromptContent = {
      text: trimmed,
      skills: this.selectedSkills.length > 0 ? [...this.selectedSkills] : undefined,
    };
    this.selectedSkills = [];

    this.errorLine = null;
    this.setBusy(true);
    this.renderChat();  // 立即显示 busy 状态

    // 记录提交前的 token 用量
    const activeBefore = this.sessionManager.getActiveSessionId();
    const sessionBefore = activeBefore ? this.sessionManager.getSession(activeBefore) : null;
    const totalTokensBefore = sessionBefore ? getTotalTokens(sessionBefore.usage) : 0;
    const promptTokensBefore = sessionBefore ? getPromptTokens(sessionBefore.usage) : 0;
    const completionTokensBefore = sessionBefore ? getCompletionTokens(sessionBefore.usage) : 0;
    const cacheHitBefore = sessionBefore ? getPromptCacheHitTokens(sessionBefore.usage) : 0;
    const cacheMissBefore = sessionBefore ? getPromptCacheMissTokens(sessionBefore.usage) : 0;
    const startedAt = Date.now();

    this.sessionManager.handleUserPrompt(prompt)
      .then(() => {
        const elapsedMs = Date.now() - startedAt;
        const sessionId = this.sessionManager.getActiveSessionId();
        if (sessionId) {
          this.loadMessagesFromSession(sessionId);

          // 生成本轮完成摘要
          const session = this.sessionManager.getSession(sessionId);
          if (session) {
            const totalTokens = getTotalTokens(session.usage);
            const roundPrompt = Math.max(0, getPromptTokens(session.usage) - promptTokensBefore);
            const roundCompletion = Math.max(0, getCompletionTokens(session.usage) - completionTokensBefore);
            const roundTokens = Math.max(0, totalTokens - totalTokensBefore);
            const roundCacheHit = Math.max(0, getPromptCacheHitTokens(session.usage) - cacheHitBefore);
            const roundCacheMiss = Math.max(0, getPromptCacheMissTokens(session.usage) - cacheMissBefore);

            const summaryMsg = buildCompletionSummary(
              session, elapsedMs, roundTokens, roundPrompt, roundCompletion,
              roundCacheHit, roundCacheMiss, this.settings.pricing,
            );
            this.addMessage("system", summaryMsg.content ?? "", {
              isSummary: true,
              statusColor: (summaryMsg.messageParams as { statusColor?: string } | null)?.statusColor,
            });
            // 持久化摘要到会话文件，避免切换会话后丢失
            this.sessionManager.addSessionMessage(sessionId, summaryMsg);
          }
        }
        this.renderChat();
        this.sessions = this.sessionManager.listSessions();
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.errorLine = msg;
        this.renderChat();
      })
      .finally(() => {
        this.setBusy(false);
        this.renderChat();
      });
  }

  /** 处理斜杠命令选择（从菜单选择或直接输入匹配） */
  private handleSlashCommandSelection(item: { kind: string; name: string; label: string }): void {
    switch (item.kind) {
      case "new":
        this.sessionManager.setActiveSessionId(null);
        this.messages = [];
        this.busy = false;
        this.errorLine = null;
        this.renderWelcome();
        break;

      case "exit":
        this.stop();
        break;

      case "resume":
        this.sessions = this.sessionManager.listSessions();
        this.renderSessionList(this.sessions);
        break;

      case "skills": {
        this.selectedSkills = [];
        this.buildSkillsInlineItems();
        this.inlineSelectKind = "skills";
        this.inlineSelectIndex = 0;
        if (this.view === "chat") this.renderChat();
        else if (this.view === "welcome") this.renderWelcome();
        this.tui.requestRender();
        break;
      }

      case "model": {
        this.buildModelInlineItems();
        this.inlineSelectKind = "model";
        this.inlineSelectIndex = 0;
        if (this.view === "chat") this.renderChat();
        else if (this.view === "welcome") this.renderWelcome();
        this.tui.requestRender();
        break;
      }

      case "thinking": {
        this.buildThinkingInlineItems();
        this.inlineSelectKind = "thinking";
        this.inlineSelectIndex = 0;
        if (this.view === "chat") this.renderChat();
        else if (this.view === "welcome") this.renderWelcome();
        this.tui.requestRender();
        break;
      }

      case "autoSwitch": {
        const newEnabled = !this.settings.autoSwitch?.enabled;
        updateModeInSettings("auto");
        if (this.settings.autoSwitch) {
          this.settings.autoSwitch.enabled = newEnabled;
        }
        this.addMessage("assistant", `自动切换模型: ${newEnabled ? "开启" : "关闭"}`);
        this.renderChat();
        break;
      }

      case "verbose": {
        this.verboseMode = !this.verboseMode;
        updateVerboseModeInSettings(this.verboseMode);
        this.addMessage("assistant", `详细模式: ${this.verboseMode ? "开启" : "关闭"}`);
        this.renderChat();
        break;
      }

      case "learn":
      case "worklog": {
        // 发送给 LLM 处理
        if (this.busy) return;
        this.addMessage("user", `/${item.name}`);
        this.renderChat();
        const prompt: UserPromptContent = { text: `/${item.name}` };
        this.errorLine = null;
        this.setBusy(true);
        this.sessionManager.handleUserPrompt(prompt)
          .then(() => {
            const sessionId = this.sessionManager.getActiveSessionId();
            if (sessionId) this.loadMessagesFromSession(sessionId);
            this.renderChat();
            this.sessions = this.sessionManager.listSessions();
          })
          .catch((error) => {
            const msg = error instanceof Error ? error.message : String(error);
            this.errorLine = msg;
            this.renderChat();
          })
          .finally(() => {
            this.setBusy(false);
            this.renderChat();
          });
        break;
      }

      case "skill": {
        this.addMessage("assistant", `已选择技能: ${item.name}`);
        this.renderChat();
        break;
      }

      default:
        break;
    }
  }

  // ── 内联选择菜单辅助方法 ──

  /** 关闭内联选择菜单 */
  private closeInlineSelect(): void {
    this.inlineSelectKind = null;
    this.inlineSelectItems = [];
    this.inlineSelectIndex = 0;
    if (this.view === "chat") this.renderChat();
    else if (this.view === "welcome") this.renderWelcome();
    this.tui.requestRender();
  }

  /** 构建模型内联选择菜单项 */
  private buildModelInlineItems(): void {
    const models = getAvailableModelNames(this.readSettings());
    this.inlineSelectItems = models.map((m) => ({
      value: m,
      label: m === this.model ? `✓ ${m}` : `  ${m}`,
      description: m === this.model ? "(当前)" : "",
    }));
    // 预选中当前模型
    const curIdx = models.indexOf(this.model);
    if (curIdx >= 0) this.inlineSelectIndex = curIdx;
  }

  /** 构建思考模式内联选择菜单项 */
  private buildThinkingInlineItems(): void {
    const te = this.settings.thinkingEnabled;
    const re = this.settings.reasoningEffort;
    this.inlineSelectItems = [
      {
        value: "toggle",
        label: te ? "  关闭思考模式" : "  开启思考模式",
        description: te ? "(当前已开启)" : "(当前已关闭)",
      },
      {
        value: "max",
        label: te && re === "max" ? "✓ 努力度: max" : "  努力度: max",
        description: "最大推理深度",
      },
      {
        value: "high",
        label: te && re === "high" ? "✓ 努力度: high" : "  努力度: high",
        description: "深度推理，略低于 max",
      },
    ];
    this.inlineSelectIndex = 0;
  }

  /** 构建技能内联选择菜单项 */
  private buildSkillsInlineItems(): void {
    this.inlineSelectItems = this.skills.map((s) => {
      const isSelected = this.selectedSkills.some((ss) => ss.name === s.name);
      return {
        value: s.name,
        label: `${isSelected ? "✓" : "○"} ${s.name}`,
        description: s.description || "",
      };
    });
    this.inlineSelectIndex = 0;
  }

  /** 处理模型选择 */
  private handleInlineModelSelect(modelName: string): void {
    const ok = updateActiveModelInSettings(modelName);
    if (ok) {
      this.model = modelName;
      this.addMessage("assistant", `已切换模型: ${modelName}`);
    }
    this.closeInlineSelect();
  }

  /** 处理思考模式选择 */
  private handleInlineThinkingSelect(value: string): void {
    if (value === "toggle") {
      const enabled = !this.settings.thinkingEnabled;
      updateThinkingConfigInSettings(enabled, this.settings.reasoningEffort);
      this.settings.thinkingEnabled = enabled;
      this.addMessage("assistant", `思考模式已${enabled ? "开启" : "关闭"}`);
    } else {
      // effort: "max" 或 "high"
      const effort = value as "high" | "max";
      updateThinkingConfigInSettings(true, effort);
      this.settings.thinkingEnabled = true;
      this.settings.reasoningEffort = effort;
      this.addMessage("assistant", `思考模式已开启 (${effort === "max" ? "最大推理深度" : "深度推理"})`);
    }
    this.closeInlineSelect();
  }

  /** 处理技能切换（不关闭菜单，可连续选择多个技能） */
  private handleInlineSkillToggle(skillName: string): void {
    const skill = this.skills.find((s) => s.name === skillName);
    if (!skill) return;

    const idx = this.selectedSkills.findIndex((s) => s.name === skillName);
    if (idx >= 0) {
      this.selectedSkills.splice(idx, 1);
    } else {
      this.selectedSkills.push(skill);
    }

    // 重建菜单项以更新 ✓/○ 标记
    this.buildSkillsInlineItems();
    if (this.view === "chat") this.renderChat();
    else if (this.view === "welcome") this.renderWelcome();
    this.tui.requestRender();
  }

  private handleSlashChange(ctx: SlashContext): void {
    // 菜单选择/关闭后临时抑制，防止重新打开
    if (this.slashMenuSuppressed) {
      this.slashMenuSuppressed = false;
      return;
    }
    const prevShow = this.showSlashMenu;
    if (ctx.token !== null) {
      this.slashItems = filterSlashCommands(
        buildSlashCommands(this.skills),
        ctx.buffer
      );
      this.slashMenuIndex = 0;
      this.showSlashMenu = this.slashItems.length > 0;
    } else {
      this.showSlashMenu = false;
      this.slashItems = [];
    }
    // 菜单可见性变化时需要重建当前视图（因为菜单组件在 renderChat/renderWelcome 中添加到 root）
    if (this.showSlashMenu !== prevShow) {
      if (this.view === "chat") this.renderChat();
      else if (this.view === "welcome") this.renderWelcome();
    }
    this.tui.requestRender();
  }

  private checkSlashMenu(): void {
    // 斜杠菜单在 handleSlashChange 中通过 onSlashChange 回调实时更新，
    // 此处不再需要轮询检测。
  }

  /** 添加消息到历史 */
  addMessage(role: MessageRole, content: string, meta?: Message["meta"], messageId?: string): void {
    // 流式增量更新：找到同 messageId 的消息并原地更新内容
    if (meta?.isStreamDelta && messageId) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].messageId === messageId) {
          this.messages[i].content = content;
          return;
        }
      }
    }
    // 最终消息（与流式消息同 id）：替换流式消息
    if (messageId) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i].messageId === messageId) {
          this.messages[i].content = content;
          this.messages[i].meta = meta;
          return;
        }
      }
    }
    this.messages.push({ role, content, timestamp: Date.now(), meta, messageId });
  }

  /** 设置 busy 状态（含终端标题栏 & 响铃通知） */
  private setBusy(value: boolean, status?: string): void {
    const wasBusy = this.busy;
    this.busy = value;

    if (value) {
      this.promptStartTime = Date.now();
      this.setTerminalTitle("⏳ Generating... — DeepSeek Code");
      // 启动 loading 文本刷新定时器
      this.startLoadingTimer();
    } else {
      // 响铃通知：生成完成时
      if (wasBusy && !value) {
        if (status === "failed") {
          this.bell(2);
          this.setTerminalTitle("✗ DeepSeek Code — 响应失败");
        } else {
          this.bell(1);
          this.setTerminalTitle("⚡ DeepSeek Code — 响应完成");
        }
        this.stopLoadingTimer();
        // 1.5 秒后恢复默认标题
        setTimeout(() => {
          if (!this.busy) this.setTerminalTitle("DeepSeek Code");
        }, 1500);
      }
    }
  }

  /** loading 文本定时器（每 500ms 刷新一次 elapsed 时间） */
  private loadingTimerId: ReturnType<typeof setInterval> | null = null;

  private startLoadingTimer(): void {
    this.stopLoadingTimer();
    this.loadingTimerId = setInterval(() => {
      if (this.busy && this.view === "chat") {
        this.tui.requestRender();
      }
    }, 500);
  }

  private stopLoadingTimer(): void {
    if (this.loadingTimerId) {
      clearInterval(this.loadingTimerId);
      this.loadingTimerId = null;
    }
  }

  /** 中断当前生成 */
  private interrupt(): void {
    if (!this.busy) return;
    this.sessionManager.interruptActiveSession();
    this.errorLine = "⚠ 已中断";
    this.setBusy(false);
    this.renderChat();
    setTimeout(() => {
      if (this.errorLine === "⚠ 已中断") {
        this.errorLine = null;
        this.renderChat();
      }
    }, 1500);
  }

  /** P3-5: 删除确认提示状态 */
  private pendingDeleteIds: string[] | null = null;

  private showDeleteConfirm(sessionIds: string[]): void {
    this.pendingDeleteIds = sessionIds;
    this.view = "session-list";
    this.root.clear();
    const box = new Box(1, 0);
    box.addChild(new Text(Theme.errorText(`  确认删除 ${sessionIds.length} 个会话？`), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Text("  Enter 确认删除 · Esc 取消", 0, 0, Theme.dimText));
    this.root.addChild(box);
  }

  private executeDelete(sessionIds: string[]): void {
    this.sessionManager.removeSessions(sessionIds);
    this.sessions = this.sessionManager.listSessions();
    this.sessionList.setSessions(this.sessions);
    this.tui.requestRender();
  }

  /** 设置终端标题栏 */
  private setTerminalTitle(text: string): void {
    process.stdout.write(`\x1b]0;${text}\x07`);
  }

  /** 响铃 */
  private bell(count = 1): void {
    process.stdout.write("\x07".repeat(count));
  }

  /** onAssistantMessage 回调: 将 SessionMessage 转换为内部 Message 并加入列表 */
  private onAssistantMessageCallback(msg: SessionMessage): void {
    // 只添加可见的、非系统消息
    if (!msg.visible) return;
    if (msg.role === "system") return;

    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content.trim() && !msg.meta?.isStepIndicator) return;

    const role: MessageRole =
      msg.role === "assistant" ? "assistant"
      : msg.role === "tool" ? "assistant" // 工具结果作为 assistant 展示
      : msg.role === "user" ? "user"
      : "system";

    const meta: Message["meta"] = {
      asThinking: msg.meta?.asThinking,
      isSummary: msg.meta?.isSummary,
      isStepIndicator: msg.meta?.isStepIndicator,
      stepDescription: msg.meta?.stepDescription,
      function: msg.meta?.function,
      paramsMd: msg.meta?.paramsMd,
      resultMd: msg.meta?.resultMd,
      isToolGroup: msg.meta?.isToolGroup,
      isStreamStart: msg.meta?.isStreamStart,
      isStreamDelta: msg.meta?.isStreamDelta,
    };

    // 步骤指示器用特殊内容（PiMessageView 会加 ● 前缀）
    if (msg.meta?.isStepIndicator && msg.meta.stepDescription) {
      this.addMessage(role, msg.meta.stepDescription, meta, msg.id);
    } else {
      this.addMessage(role, content, meta, msg.id);
    }
    this.renderChat();
  }

  /** 从 SessionManager 加载消息到内部 messages 列表。可指定 sinceMessageIndex 截断前面的消息。 */
  private loadMessagesFromSession(sessionId: string, sinceMessageIndex?: number): void {
    const allMessages = this.sessionManager.listSessionMessages(sessionId);

    // 先过滤出可见且非纯系统消息
    let filtered = allMessages.filter(
      (m) => m.visible && (m.role !== "system" || m.meta?.isSummary)
    );

    // 截断：从指定索引开始（用于提问列表跳转）
    if (sinceMessageIndex !== undefined && sinceMessageIndex > 0 && sinceMessageIndex < filtered.length) {
      const skippedCount = sinceMessageIndex;
      filtered = filtered.slice(sinceMessageIndex);
      // 在开头插入省略提示
      const now = new Date().toISOString();
      filtered = [{
        id: `skip-hint-${Date.now()}`,
        sessionId,
        role: "system" as const,
        content: `↑ 上方有 ${skippedCount} 条更早的消息已省略`,
        contentParams: null,
        messageParams: null,
        compacted: false,
        visible: true,
        createTime: now,
        updateTime: now,
        meta: { isSummary: true },
      }, ...filtered];
    }

    this.messages = filtered.map((m) => ({
        role:
          m.role === "assistant" ? "assistant" as MessageRole
          : m.role === "tool" ? "assistant" as MessageRole
          : m.role === "user" ? "user" as MessageRole
          : "system" as MessageRole,
        content: m.meta?.isStepIndicator && m.meta.stepDescription
          ? m.meta.stepDescription
          : typeof m.content === "string" ? m.content : "",
        timestamp: Date.parse(m.createTime) || Date.now(),
        meta: {
          asThinking: m.meta?.asThinking,
          isSummary: m.meta?.isSummary,
          isStepIndicator: m.meta?.isStepIndicator,
          stepDescription: m.meta?.stepDescription,
          function: m.meta?.function,
          paramsMd: m.meta?.paramsMd,
          resultMd: m.meta?.resultMd,
          isToolGroup: m.meta?.isToolGroup,
        },
      }));
  }

  /** 创建 OpenAI 客户端 */
  private createOpenAIClient(overrideModel?: string): {
    client: OpenAI | null;
    model: string;
    baseURL: string;
    thinkingEnabled: boolean;
    reasoningEffort: "high" | "max";
    notify?: string;
    webSearchTool?: string;
    machineId?: string;
  } {
    let resolved = this.settings;
    if (overrideModel) {
      try {
        resolved = resolveSettings(
          this.readSettings(),
          { model: overrideModel, baseURL: DEFAULT_BASE_URL }
        );
      } catch {
        // 使用当前 settings
      }
    }

    if (!resolved.apiKey) {
      return {
        client: null,
        model: resolved.model,
        baseURL: resolved.baseURL,
        thinkingEnabled: resolved.thinkingEnabled,
        reasoningEffort: resolved.reasoningEffort,
        notify: resolved.notify,
        webSearchTool: resolved.webSearchTool,
        machineId: this.getMachineId(),
      };
    }

    const client = new OpenAI({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL || undefined,
      maxRetries: 2,
      timeout: 300_000,
    });

    return {
      client,
      model: resolved.model,
      baseURL: resolved.baseURL,
      thinkingEnabled: resolved.thinkingEnabled,
      reasoningEffort: resolved.reasoningEffort,
      notify: resolved.notify,
      webSearchTool: resolved.webSearchTool,
      machineId: this.getMachineId(),
    };
  }

  /** 读取 settings.json */
  private readSettings(): DeepcodingSettings | null {
    try {
      const settingsPath = path.join(os.homedir(), ".deepseek-code", "settings.json");
      if (!fs.existsSync(settingsPath)) return null;
      const raw = fs.readFileSync(settingsPath, "utf8");
      return JSON.parse(raw) as DeepcodingSettings;
    } catch {
      return null;
    }
  }

  /** 获取或生成 machine-id */
  private getMachineId(): string | undefined {
    try {
      const idPath = path.join(os.homedir(), ".deepseek-code", "machine-id");
      if (fs.existsSync(idPath)) {
        const raw = fs.readFileSync(idPath, "utf8").trim();
        if (raw) return raw;
      }
      const generated = `${os.hostname()}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      fs.mkdirSync(path.dirname(idPath), { recursive: true });
      fs.writeFileSync(idPath, generated, "utf8");
      return generated;
    } catch {
      return undefined;
    }
  }

  /** P2: 切换帮助浮层 */
  private toggleHelp(): void {
    this.showHelpOverlay = !this.showHelpOverlay;
    if (this.view === "welcome") {
      this.renderWelcome();
    } else {
      this.renderChat();
    }
    this.tui.requestRender();
  }
}
