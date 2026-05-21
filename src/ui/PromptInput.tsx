import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import chalk from "chalk";
import {
  EMPTY_BUFFER,
  PromptBufferState,
  backspace,
  deleteForward,
  deleteWordBefore,
  getCurrentSlashToken,
  insertText,
  isEmpty,
  killLine,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  moveUp,
} from "./promptBuffer";
import {
  SlashCommandItem,
  buildSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
} from "./slashCommands";
import { readClipboardImage } from "./clipboard";
import { getModelProviderLabel } from "../model-capabilities";
import type { ReasoningEffort } from "../settings";
import type { SkillInfo } from "../session";
import { useTerminalInput } from "./useTerminalInput";
import { SlashCommandList } from "./SlashCommandList";
import { ModelDropdown, ThinkingMenu, SkillsDropdown, ModeStatusBar } from "./ModeBar";

export type PromptSubmission = {
  text: string;
  imageUrls: string[];
  selectedSkills?: SkillInfo[];
  command?: "new" | "resume" | "exit";
};

type Props = {
  skills: SkillInfo[];
  activeModel: string;
  modelList: string[];
  onModelChange: (modelName: string) => void;
  activeThinking: boolean;
  activeReasoningEffort: ReasoningEffort;
  onThinkingChange: (thinkingEnabled: boolean, reasoningEffort?: ReasoningEffort) => void;
  activeMode: string;
  onAutoSwitchChange: (newMode: string) => void;
  verboseMode: boolean;
  onVerboseChange: (verbose: boolean) => void;
  promptHistory: string[];
  busy: boolean;
  loadingText?: string | null;
  disabled?: boolean;
  onSubmit: (submission: PromptSubmission) => void;
  onInterrupt: () => void;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const PromptInput = memo(function PromptInput({
  skills,
  activeModel,
  modelList,
  onModelChange,
  activeThinking,
  activeReasoningEffort,
  onThinkingChange,
  activeMode,
  onAutoSwitchChange,
  verboseMode,
  onVerboseChange,
  promptHistory,
  busy,
  loadingText,
  disabled,
  onSubmit,
  onInterrupt,
}: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const screenWidth = Math.max(20, stdout?.columns ?? 80);
  const [buffer, setBuffer] = useState<PromptBufferState>(EMPTY_BUFFER);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<SkillInfo[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [showSkillsDropdown, setShowSkillsDropdown] = useState(false);
  const [skillsDropdownIndex, setSkillsDropdownIndex] = useState(0);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelDropdownIndex, setModelDropdownIndex] = useState(0);
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);
  const [thinkingMenuIndex, setThinkingMenuIndex] = useState(0);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(null);
  const [hasTerminalFocus, setHasTerminalFocus] = useState(true);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const lastCtrlDAt = useRef<number>(0);

  const slashItems = useMemo(() => buildSlashCommands(skills), [skills]);
  const slashToken = getCurrentSlashToken(buffer);
  const slashMenu = (showSkillsDropdown || showModelDropdown || showThinkingMenu) ? [] : slashToken ? filterSlashCommands(slashItems, slashToken) : [];
  const showMenu = slashMenu.length > 0;
  const promptHistoryKey = useMemo(() => promptHistory.join("\0"), [promptHistory]);
  const promptPrefix = busy ? `${SPINNER_FRAMES[spinnerIndex]} ` : "❯ ";
  const formatModelDisplay = (modelName: string): string => {
    const provider = getModelProviderLabel(modelName);
    return provider ? `${modelName} (${provider})` : modelName;
  };

  const cursorPlacement = useMemo(
    () => getPromptCursorPlacement(buffer, screenWidth, promptPrefix),
    [buffer, promptPrefix, screenWidth]
  );

  useTerminalFocusReporting(stdout, !disabled);
  usePromptTerminalCursor(stdout, cursorPlacement, !disabled);

  useEffect(() => {
    if (!busy) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [busy]);

  // Detect when the slashItems set changes (e.g. skills finish loading while menu is open)
  const prevSlashItemsRef = useRef(slashItems);
  const menuIndexRef = useRef(menuIndex);
  menuIndexRef.current = menuIndex;
  useEffect(() => {
    if (prevSlashItemsRef.current !== slashItems) {
      const prevItems = prevSlashItemsRef.current;
      const currentMenuIndex = menuIndexRef.current;
      const selectedItem = prevItems[currentMenuIndex];
      prevSlashItemsRef.current = slashItems;
      if (selectedItem) {
        const newIndex = slashItems.findIndex(
          (item) => item.kind === selectedItem.kind && item.name === selectedItem.name
        );
        setMenuIndex(newIndex >= 0 ? newIndex : 0);
      } else {
        setMenuIndex(0);
      }
    }
  }, [slashItems]);

  useEffect(() => {
    if (!showMenu) {
      return;
    }
    setStatusMessage("↑/↓ 导航 · Enter 选择 · Esc 关闭");
    return () => setStatusMessage(null);
  }, [showMenu]);

  useEffect(() => {
    setMenuIndex(0);
  }, [slashToken]);

  // Close all dropdowns and exit browsing state on Esc
  const closeAllMenus = () => {
    setShowSkillsDropdown(false);
    setShowModelDropdown(false);
    setShowThinkingMenu(false);
    setPendingExit(false);
    if (historyCursor !== -1) {
      setHistoryCursor(-1);
      setDraftBeforeHistory(null);
    }
  };

  // ── Keyboard input handling via useTerminalInput ──
  useTerminalInput((input, key) => {
    // ── Global interrupts ──
    if (key.escape) {
      if (showSkillsDropdown || showModelDropdown || showThinkingMenu || showMenu || pendingExit) {
        closeAllMenus();
        return;
      }
      if (busy) {
        onInterrupt();
        return;
      }
      return;
    }

    // Ctrl+D 双击退出（parseTerminalInput 已将 \x04 转为 "d" + ctrl:true）
    if (key.ctrl && (input === "d" || input === "D")) {
      if (busy) return;
      const now = Date.now();
      if (lastCtrlDAt.current && now - lastCtrlDAt.current < 800) {
        onSubmit({ text: "", imageUrls: [], command: "exit" });
        return;
      }
      closeAllMenus();
      lastCtrlDAt.current = now;
      setPendingExit(true);
      setStatusMessage("再按一次 Ctrl+D 退出");
      setTimeout(() => {
        setPendingExit(false);
        setStatusMessage(null);
      }, 2000);
      return;
    }

    if (key.ctrl && key.tab) {
      return;
    }

    // ── Skills dropdown navigation ──
    if (showSkillsDropdown) {
      if (key.upArrow) {
        setSkillsDropdownIndex((idx) => (idx - 1 + skills.length) % skills.length);
        return;
      }
      if (key.downArrow) {
        setSkillsDropdownIndex((idx) => (idx + 1) % skills.length);
        return;
      }
      if (input === " ") {
        const skill = skills[skillsDropdownIndex];
        if (skill) {
          setSelectedSkills((prev) => toggleSkillSelection(prev, skill));
        }
        return;
      }
      if (key.return || key.tab) {
        setShowSkillsDropdown(false);
        return;
      }
      return;
    }

    // ── Model dropdown navigation ──
    if (showModelDropdown) {
      if (key.upArrow) {
        setModelDropdownIndex((idx) => (idx - 1 + modelList.length) % modelList.length);
        return;
      }
      if (key.downArrow) {
        setModelDropdownIndex((idx) => (idx + 1) % modelList.length);
        return;
      }
      if (key.return || key.tab) {
        const selected = modelList[modelDropdownIndex];
        if (selected) {
          onModelChange(selected);
        }
        setShowModelDropdown(false);
        return;
      }
      return;
    }

    // ── Thinking menu navigation ──
    if (showThinkingMenu) {
      if (key.upArrow) {
        setThinkingMenuIndex((idx) => (idx - 1 + 3) % 3);
        return;
      }
      if (key.downArrow) {
        setThinkingMenuIndex((idx) => (idx + 1) % 3);
        return;
      }
      if (key.return || input === " ") {
        if (thinkingMenuIndex === 0) {
          onThinkingChange(!activeThinking, activeReasoningEffort);
        } else if (thinkingMenuIndex === 1) {
          onThinkingChange(true, "max");
        } else if (thinkingMenuIndex === 2) {
          onThinkingChange(true, "high");
        }
        setShowThinkingMenu(false);
        return;
      }
      return;
    }

    if (busy && (key.return || (showMenu && key.tab))) {
      setStatusMessage("请等待当前响应完成，或按 Esc 中断");
      return;
    }

    // ── Slash menu navigation ──
    if (showMenu) {
      if (key.upArrow) {
        setMenuIndex((idx) => (idx - 1 + slashMenu.length) % slashMenu.length);
        return;
      }
      if (key.downArrow) {
        setMenuIndex((idx) => (idx + 1) % slashMenu.length);
        return;
      }
      if (key.tab || (key.return && !key.shift && !key.meta)) {
        const selected = slashMenu[menuIndex];
        if (selected) {
          handleSlashSelection(selected);
          return;
        }
      }
    }

    // ── Regular input ──
    if (key.return) {
      if (key.shift || key.meta) {
        updateBuffer((s) => insertText(s, "\n"));
        return;
      }
      submitCurrentBuffer();
      return;
    }

    if (key.delete) {
      updateBuffer((s) => deleteForward(s));
      return;
    }

    if (key.backspace) {
      updateBuffer((s) => backspace(s));
      return;
    }

    if ((key.ctrl || key.meta) && key.leftArrow) {
      updateBuffer((s) => moveWordLeft(s));
      return;
    }

    if ((key.ctrl || key.meta) && key.rightArrow) {
      updateBuffer((s) => moveWordRight(s));
      return;
    }

    if (key.leftArrow) {
      updateBuffer((s) => moveLeft(s));
      return;
    }

    if (key.rightArrow) {
      updateBuffer((s) => moveRight(s));
      return;
    }

    if (key.home) {
      updateBuffer((s) => moveLineStart(s));
      return;
    }

    if (key.end) {
      updateBuffer((s) => moveLineEnd(s));
      return;
    }

    if (key.upArrow) {
      const noModifier = !key.shift && !key.ctrl && !key.meta;
      if (noModifier && (historyCursor !== -1 || buffer.cursor === 0) && promptHistory.length > 0) {
        navigateHistory(-1);
        return;
      }
      updateBuffer((s) => moveUp(s));
      return;
    }

    if (key.downArrow) {
      const noModifier = !key.shift && !key.ctrl && !key.meta;
      if (noModifier && (historyCursor !== -1 || buffer.cursor === buffer.text.length)) {
        navigateHistory(1);
        return;
      }
      updateBuffer((s) => moveDown(s));
      return;
    }

    if (key.ctrl && (input === "p" || input === "P")) {
      navigateHistory(-1);
      return;
    }

    if (key.ctrl && (input === "n" || input === "N")) {
      navigateHistory(1);
      return;
    }

    if (key.ctrl && (input === "a" || input === "A")) {
      updateBuffer((s) => moveLineStart(s));
      return;
    }

    if (key.ctrl && (input === "e" || input === "E")) {
      updateBuffer((s) => moveLineEnd(s));
      return;
    }

    if (key.ctrl && (input === "b" || input === "B")) {
      updateBuffer((s) => moveLeft(s));
      return;
    }

    if (key.ctrl && (input === "f" || input === "F")) {
      updateBuffer((s) => moveRight(s));
      return;
    }

    if (key.meta && (input === "b" || input === "B")) {
      updateBuffer((s) => moveWordLeft(s));
      return;
    }

    if (key.meta && (input === "f" || input === "F")) {
      updateBuffer((s) => moveWordRight(s));
      return;
    }

    if (key.ctrl && (input === "k" || input === "K")) {
      updateBuffer((s) => killLine(s));
      return;
    }

    if (key.ctrl && (input === "z" || input === "Z")) {
      updateBuffer(() => EMPTY_BUFFER);
      setStatusMessage("已撤销输入");
      return;
    }

    if (key.ctrl && (input === "u" || input === "U")) {
      updateBuffer(() => EMPTY_BUFFER);
      return;
    }

    if (key.ctrl && (input === "w" || input === "W")) {
      updateBuffer((s) => deleteWordBefore(s));
      return;
    }

    if (key.ctrl && (input === "j" || input === "J")) {
      updateBuffer((s) => insertText(s, "\n"));
      return;
    }

    if (input.startsWith("\u001b")) {
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const sanitized = input.replace(/\r/g, "");
      updateBuffer((s) => insertText(s, sanitized));
    }
  }, !disabled);

  // ── Slash command selection handler ──
  function handleSlashSelection(item: SlashCommandItem): void {
    const updated = removeCurrentSlashToken(buffer);
    setBuffer(updated);

    switch (item.kind) {
      case "new":
        closeAllMenus();
        onSubmit({ text: "", imageUrls: [], command: "new" });
        return;
      case "resume":
        closeAllMenus();
        onSubmit({ text: "", imageUrls: [], command: "resume" });
        return;
      case "exit":
        closeAllMenus();
        onSubmit({ text: "", imageUrls: [], command: "exit" });
        return;
      case "skills":
        setShowSkillsDropdown(true);
        setSkillsDropdownIndex(0);
        return;
      case "model":
        setShowModelDropdown(true);
        setModelDropdownIndex(modelList.indexOf(activeModel) >= 0 ? modelList.indexOf(activeModel) : 0);
        return;
      case "thinking":
        setShowThinkingMenu(true);
        setThinkingMenuIndex(0);
        return;
      case "autoSwitch": {
        const newMode = activeMode === "auto" ? "manual" : "auto";
        onAutoSwitchChange(newMode);
        setStatusMessage(newMode === "auto" ? "自动切换已开启" : "自动切换已关闭");
        return;
      }
      case "verbose": {
        onVerboseChange(!verboseMode);
        setStatusMessage(!verboseMode ? "详细模式已开启" : "详细模式已关闭");
        return;
      }
      case "learn":
      case "worklog":
        onSubmit({ text: `/${item.name}`, imageUrls: [], selectedSkills });
        return;
      case "skill":
        if (item.skill) {
          setSelectedSkills((prev) => addUniqueSkill(prev, item.skill!));
          setStatusMessage(`已选择技能: ${item.skill.name}，输入消息后发送即可使用`);
        }
        return;
    }
  }

  // ── History navigation ──
  function exitHistoryBrowsing(): void {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }

  function updateBuffer(updater: (state: PromptBufferState) => PromptBufferState): void {
    exitHistoryBrowsing();
    setBuffer(updater);
  }

  function navigateHistory(direction: -1 | 1): void {
    if (promptHistory.length === 0) return;

    const previousCursor = historyCursor === -1 ? promptHistory.length : historyCursor;
    const nextCursor = Math.max(0, Math.min(promptHistory.length, previousCursor + direction));
    const draft = historyCursor === -1 ? buffer.text : draftBeforeHistory;

    if (nextCursor === promptHistory.length) {
      setBuffer({ text: draft ?? "", cursor: (draft ?? "").length });
      setHistoryCursor(-1);
      setDraftBeforeHistory(null);
      return;
    }

    const text = promptHistory[nextCursor];
    setBuffer({ text, cursor: text.length });

    if (historyCursor === -1) {
      setDraftBeforeHistory(draft ?? "");
    }
    setHistoryCursor(nextCursor);
  }

  // ── Submit handler ──
  const submitCurrentBuffer = () => {
    if (busy) return;

    const text = buffer.text;
    const trimmed = text.replace(/\n/g, " ").trim();

    // Ctrl+D twice to exit
    if (keyIsCtrlD(text)) {
      const now = Date.now();
      if (lastCtrlDAt.current && now - lastCtrlDAt.current < 800) {
        onSubmit({ text: "", imageUrls: [], command: "exit" });
        return;
      }
      lastCtrlDAt.current = now;
      setPendingExit(true);
      setStatusMessage("再按一次 Ctrl+D 退出");
      setTimeout(() => {
        setPendingExit(false);
        setStatusMessage(null);
      }, 2000);
      return;
    }

    if (!trimmed && imageUrls.length === 0 && selectedSkills.length === 0) return;

    // Slash commands
    if (trimmed.startsWith("/")) {
      const exact = findExactSlashCommand(slashItems, trimmed);
      if (exact) {
        handleSlashSelection(exact);
        return;
      }
    }

    onSubmit({
      text,
      imageUrls,
      selectedSkills: selectedSkills.length > 0 ? selectedSkills : undefined,
    });
    setBuffer(EMPTY_BUFFER);
    setImageUrls([]);
    setSelectedSkills([]);
    setStatusMessage(null);
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  };

  // ── JSX rendering ──
  const divider = "─".repeat(Math.min(screenWidth, 80));

  return (
    <Box flexDirection="column">
      {imageUrls.length > 0 ? (
        <Text dimColor>{formatImageAttachmentStatus(imageUrls.length)} · Ctrl+X 清除图片</Text>
      ) : null}
      {selectedSkills.length > 0 ? (
        <Text dimColor>{formatSelectedSkillsStatus(selectedSkills)}</Text>
      ) : null}

      {showSkillsDropdown ? (
        <SkillsDropdown
          skills={skills}
          selectedIndex={skillsDropdownIndex}
          selectedSkills={selectedSkills}
          onToggle={(skill) => setSelectedSkills((prev) => toggleSkillSelection(prev, skill))}
          onClose={() => setShowSkillsDropdown(false)}
        />
      ) : null}

      {showModelDropdown ? (
        <ModelDropdown
          modelList={modelList}
          selectedIndex={modelDropdownIndex}
          onSelect={(model) => {
            onModelChange(model);
            setShowModelDropdown(false);
          }}
          onClose={() => setShowModelDropdown(false)}
        />
      ) : null}

      {showThinkingMenu ? (
        <ThinkingMenu
          activeThinking={activeThinking}
          activeReasoningEffort={activeReasoningEffort}
          selectedIndex={thinkingMenuIndex}
          onToggle={(enabled, effort) => {
            onThinkingChange(enabled, effort);
            setShowThinkingMenu(false);
          }}
          onClose={() => setShowThinkingMenu(false)}
        />
      ) : null}

      {showMenu ? (
        <SlashCommandList items={slashMenu} selectedIndex={menuIndex} />
      ) : null}

      <Text dimColor>{divider}</Text>
      <Box>
        <Text color={busy ? "yellow" : "green"}>{promptPrefix}</Text>
        <Text>{renderBufferWithCursor(buffer, !disabled && hasTerminalFocus)}</Text>
      </Box>
      <Text dimColor>{divider}</Text>
      <Box>
        <ModeStatusBar
          busy={busy}
          loadingText={loadingText}
          activeModel={activeModel}
          activeThinking={activeThinking}
          activeReasoningEffort={activeReasoningEffort}
          verboseMode={verboseMode}
          activeMode={activeMode}
        />
      </Box>
    </Box>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 导出工具函数
// ═══════════════════════════════════════════════════════════════════════════

export const IMAGE_ATTACHMENT_CLEAR_HINT = "Ctrl+X 清除图片";

export function formatImageAttachmentStatus(count: number): string {
  if (count <= 0) return "";
  return `📎 ${count} image${count === 1 ? "" : "s"} attached`;
}

export function formatSelectedSkillsStatus(skills: SkillInfo[]): string {
  const names = skills.map((skill) => skill.name).filter(Boolean);
  if (names.length === 0) return "";
  return `⚡ ${names.join(", ")}`;
}

export function isSkillSelected(skills: SkillInfo[], skill: SkillInfo): boolean {
  return skills.some((item) => item.name === skill.name);
}

export function addUniqueSkill(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  if (isSkillSelected(skills, skill)) return skills;
  return [...skills, skill];
}

export function toggleSkillSelection(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  return isSkillSelected(skills, skill)
    ? skills.filter((item) => item.name !== skill.name)
    : [...skills, skill];
}

export function removeCurrentSlashToken(state: PromptBufferState): PromptBufferState {
  let start = state.cursor;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) {
    start -= 1;
  }

  const token = state.text.slice(start, state.cursor);
  if (!token.startsWith("/")) return state;

  const text = `${state.text.slice(0, start)}${state.text.slice(state.cursor)}`;
  return { text, cursor: start };
}

export function isClearImageAttachmentsShortcut(input: string, key: { ctrl: boolean }): boolean {
  return key.ctrl && (input === "x" || input === "X");
}

// ═══════════════════════════════════════════════════════════════════════════
// 光标管理
// ═══════════════════════════════════════════════════════════════════════════

type CursorPlacement = {
  rowsUp: number;
  column: number;
};

type WriteFn = (
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void
) => boolean;

function usePromptTerminalCursor(
  stdout: NodeJS.WriteStream | undefined,
  placement: CursorPlacement,
  isActive: boolean,
): void {
  const directWriteRef = useRef<((data: string) => void) | null>(null);
  const activePlacementRef = useRef<CursorPlacement | null>(null);

  useLayoutEffect(() => {
    if (!stdout?.isTTY) return;

    const stream = stdout as NodeJS.WriteStream & { write: WriteFn };
    const originalWrite = stream.write;
    const directWrite = (data: string) => {
      stream.write(data);
    };
    directWriteRef.current = directWrite;

    stream.write = function patchedWrite(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      const placement2 = activePlacementRef.current;
      if (placement2) {
        directWrite("\u001B7"); // Save cursor
        directWrite(`\u001B[${placement2.rowsUp}A`); // Move up
        directWrite(`\u001B[${placement2.column}G`); // Move to column
        const result = originalWrite.call(stream, chunk, encodingOrCallback as any, callback as any);
        directWrite("\u001B8"); // Restore cursor
        return result;
      }
      return originalWrite.call(stream, chunk, encodingOrCallback as any, callback as any);
    };

    return () => {
      stream.write = originalWrite;
    };
  }, [stdout]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 终端焦点上报
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 终端焦点上报 hook（已禁用）。
 *
 * 原实现在 stdout 上监听 "data" 事件来检测焦点转义序列（\u001b[I / \u001b[O），
 * 但 stdout 是 WriteStream，不应有 data 事件。在 WSL ConPTY 环境下 stdout 是 Duplex，
 * stdout.on("data") 可能截获本该由 stdin 处理的按键数据，导致快速输入丢失。
 *
 * 焦点事件已合并到 parseTerminalInput 中（focusIn/focusOut 标志），
 * 由 useTerminalInput 统一处理，无需单独监听 stdout。
 */
function useTerminalFocusReporting(
  _stdout: NodeJS.WriteStream | undefined,
  _enabled: boolean,
): void {
  // 已禁用：焦点事件由 useTerminalInput 通过 stdin 统一处理
}

// ═══════════════════════════════════════════════════════════════════════════
// 光标位置计算与 Buffer 渲染
// ═══════════════════════════════════════════════════════════════════════════

export function getPromptCursorPlacement(
  buffer: PromptBufferState,
  screenWidth: number,
  promptPrefix: string,
  _footerText?: string,
): CursorPlacement {
  // 原版逻辑：footerText 用于预留分隔行和状态栏行
  const dividerLines = _footerText ? 2 : 0; // 分隔行 + 状态栏
  const lines = buffer.text.split("\n");
  const totalLines = lines.length;
  const lastLineLength = lines[totalLines - 1]?.length ?? 0;
  const cursorRow = Math.floor(buffer.cursor / screenWidth) + 1;
  return {
    rowsUp: cursorRow + dividerLines,
    column: (buffer.cursor % screenWidth) + promptPrefix.length + 1,
  };
}

export function renderBufferWithCursor(buffer: PromptBufferState, showCursor: boolean): string {
  if (!showCursor || buffer.cursor < 0 || buffer.cursor > buffer.text.length) {
    return buffer.text;
  }
  const before = buffer.text.slice(0, buffer.cursor);
  const at = buffer.text[buffer.cursor] ?? " ";
  const after = buffer.text.slice(buffer.cursor + 1);
  return `${before}${chalk.inverse(at)}${after}`;
}

/** 判断文本是否为 Ctrl+D 退出键 */
function keyIsCtrlD(text: string): boolean {
  return text.length === 1 && text.charCodeAt(0) === 4;
}
