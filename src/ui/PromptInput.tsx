import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useStdin, useStdout } from "ink";
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
  moveUp
} from "./promptBuffer";
import {
  SlashCommandItem,
  buildSlashCommands,
  filterSlashCommands,
  findExactSlashCommand,
  formatSlashCommandDescription,
  formatSlashCommandLabel
} from "./slashCommands";
import { readClipboardImage } from "./clipboard";
import { getModelProviderLabel } from "../model-capabilities";
import type { ReasoningEffort } from "../settings";
import type { SkillInfo } from "../session";

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

const BACKSPACE_BYTES = new Set(["", ""]);
const FORWARD_DELETE_SEQUENCES = new Set(["[3~", "[P"]);
const HOME_SEQUENCES = new Set(["[H", "[1~", "[7~", "OH"]);
const END_SEQUENCES = new Set(["[F", "[4~", "[8~", "OF"]);
const SHIFT_RETURN_SEQUENCES = new Set(["\r", "[13;2u"]);
const META_RETURN_SEQUENCES = new Set(["[13;3u", "[13;4u"]);
const CTRL_LEFT_SEQUENCES = new Set(["[1;5D", "[5D"]);
const CTRL_RIGHT_SEQUENCES = new Set(["[1;5C", "[5C"]);
const META_LEFT_SEQUENCES = new Set(["[1;3D", "[3D", "b"]);
const META_RIGHT_SEQUENCES = new Set(["[1;3C", "[3C", "f"]);
const TERMINAL_FOCUS_IN = "[I";
const TERMINAL_FOCUS_OUT = "[O";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type InputKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  home: boolean;
  end: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  focusIn: boolean;
  focusOut: boolean;
};

export function PromptInput({
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
  onInterrupt
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

  const footerText = statusMessage
    ? statusMessage
    : busy
      ? loadingText && loadingText.trim()
        ? `${loadingText} · model: ${formatModelDisplay(activeModel)}`
        : `Esc: 中断响应 · Ctrl+C: 取消输入 · model: ${formatModelDisplay(activeModel)}`
      : `Ctrl+Z: 撤销输入 · Enter: 发送 · Shift+Enter: 换行 · Ctrl+V: 粘贴图片 · /: 命令菜单 · Ctrl+D: 退出 · model: ${formatModelDisplay(activeModel)} · thinking: ${activeThinking ? activeReasoningEffort : "off"} · verbose: ${verboseMode ? "on" : "off"} · autoSwitch: ${activeMode === "auto" ? "on" : "off"}`;
  const cursorPlacement = useMemo(
    () => getPromptCursorPlacement(buffer, screenWidth, promptPrefix, footerText),
    [buffer, footerText, promptPrefix, screenWidth]
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
  // so menuIndex stays aligned with the correct item when items are prepended.
  const prevSlashItemsRef = useRef(slashItems);
  const menuIndexRef = useRef(menuIndex);
  menuIndexRef.current = menuIndex;
  useEffect(() => {
    if (prevSlashItemsRef.current !== slashItems) {
      const prevItems = prevSlashItemsRef.current;
      const currentMenuIndex = menuIndexRef.current;
      const selectedItem = prevItems[currentMenuIndex];
      prevSlashItemsRef.current = slashItems;

      // Try to keep the same item selected across the list change
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
      setMenuIndex(0);
      return;
    }
    if (menuIndex >= slashMenu.length) {
      setMenuIndex(slashMenu.length - 1);
    }
  }, [slashMenu, showMenu, menuIndex]);

  useEffect(() => {
    if (skillsDropdownIndex >= skills.length) {
      setSkillsDropdownIndex(Math.max(0, skills.length - 1));
    }
  }, [skills.length, skillsDropdownIndex]);

  useEffect(() => {
    if (modelDropdownIndex >= modelList.length) {
      setModelDropdownIndex(Math.max(0, modelList.length - 1));
    }
  }, [modelList.length, modelDropdownIndex]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }
    const timer = setTimeout(() => setStatusMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }, [promptHistoryKey]);

  useTerminalInput((input, key) => {
    if (key.focusIn) {
      setHasTerminalFocus(true);
      return;
    }
    if (key.focusOut) {
      setHasTerminalFocus(false);
      return;
    }

    if (disabled) {
      return;
    }

    if (key.escape) {
      if (showSkillsDropdown) {
        setShowSkillsDropdown(false);
        return;
      }
      if (showModelDropdown) {
        setShowModelDropdown(false);
        return;
      }
      if (showThinkingMenu) {
        setShowThinkingMenu(false);
        return;
      }
      if (busy) {
        onInterrupt();
        setStatusMessage("正在中断……");
      }
      return;
    }

    if (key.ctrl && (input === "d" || input === "D")) {
      if (!isEmpty(buffer)) {
        updateBuffer((s) => deleteForward(s));
        return;
      }
      const now = Date.now();
      if (pendingExit && now - lastCtrlDAt.current < 2000) {
        exit();
        process.exit(0);
        return;
      }
      lastCtrlDAt.current = now;
      setPendingExit(true);
      setStatusMessage("再次按 Ctrl+D 确认退出");
      return;
    }

    if (key.ctrl && (input === "c" || input === "C")) {
      if (busy) {
        onInterrupt();
        setStatusMessage("正在中断……");
      } else if (!isEmpty(buffer)) {
        setBuffer(EMPTY_BUFFER);
      } else {
        setStatusMessage("按 Ctrl+D 退出程序");
      }
      return;
    }

    if (pendingExit && (!key.ctrl || (input !== "d" && input !== "D"))) {
      setPendingExit(false);
    }

    if (historyCursor !== -1 && !key.upArrow && !key.downArrow) {
      exitHistoryBrowsing();
    }

    if (showSkillsDropdown) {
      if (key.upArrow) {
        setSkillsDropdownIndex((idx) => (idx - 1 + Math.max(skills.length, 1)) % Math.max(skills.length, 1));
        return;
      }
      if (key.downArrow) {
        setSkillsDropdownIndex((idx) => (idx + 1) % Math.max(skills.length, 1));
        return;
      }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        const skill = skills[skillsDropdownIndex];
        if (skill) {
          toggleSelectedSkill(skill);
        }
        return;
      }
      if (key.tab) {
        setShowSkillsDropdown(false);
        return;
      }
    }

    if (showModelDropdown) {
      if (key.upArrow) {
        setModelDropdownIndex((idx) => (idx - 1 + Math.max(modelList.length, 1)) % Math.max(modelList.length, 1));
        return;
      }
      if (key.downArrow) {
        setModelDropdownIndex((idx) => (idx + 1) % Math.max(modelList.length, 1));
        return;
      }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        const modelName = modelList[modelDropdownIndex];
        if (modelName) {
          onModelChange(modelName);
          setStatusMessage(`已切换到 ${modelName}`);
          setShowModelDropdown(false);
        }
        return;
      }
      if (key.tab) {
        setShowModelDropdown(false);
        return;
      }
    }

    if (showThinkingMenu) {
      const thinkingOptions = buildThinkingOptions(activeThinking, activeReasoningEffort);
      if (key.upArrow) {
        setThinkingMenuIndex((idx) => (idx - 1 + Math.max(thinkingOptions.length, 1)) % Math.max(thinkingOptions.length, 1));
        return;
      }
      if (key.downArrow) {
        setThinkingMenuIndex((idx) => (idx + 1) % Math.max(thinkingOptions.length, 1));
        return;
      }
      if ((input === " " && !key.ctrl && !key.meta) || (key.return && !key.shift && !key.meta)) {
        const option = thinkingOptions[thinkingMenuIndex];
        if (option) {
          if (option.kind === "toggle") {
            const newValue = !activeThinking;
            const effort = newValue ? activeReasoningEffort : undefined;
            onThinkingChange(newValue, effort);
            setStatusMessage(newValue ? `思考模式已开启 (${activeReasoningEffort})` : "思考模式已关闭");
          } else if (option.kind === "effort" && option.value) {
            onThinkingChange(activeThinking, option.value);
            setStatusMessage(`思考努力度已设为 ${option.value}`);
          }
          setShowThinkingMenu(false);
        }
        return;
      }
      if (key.tab) {
        setShowThinkingMenu(false);
        return;
      }
    }

    if (key.ctrl && (input === "v" || input === "V")) {
      const image = readClipboardImage();
      if (image) {
        setImageUrls((prev) => [...prev, image.dataUrl]);
        setStatusMessage("已从剪贴板粘贴图片");
      } else {
        setStatusMessage("剪贴板中未找到图片");
      }
      return;
    }

    if (isClearImageAttachmentsShortcut(input, key)) {
      if (imageUrls.length > 0) {
        setImageUrls([]);
        setStatusMessage("已清除所有已粘贴的图片");
      } else {
        setStatusMessage("当前没有已粘贴的图片");
      }
      return;
    }

    const noModifier = !key.shift && !key.ctrl && !key.meta;
    const isPlainReturn = key.return && !key.shift && !key.meta;

    if (busy && (isPlainReturn || (showMenu && key.tab))) {
      setStatusMessage("请等待当前响应完成，或按 Esc 中断");
      return;
    }

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

    if (key.return) {
      const isShiftEnter = key.shift || key.meta;
      if (isShiftEnter) {
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
      if (noModifier && (historyCursor !== -1 || buffer.cursor === 0) && promptHistory.length > 0) {
        navigateHistory(-1);
        return;
      }
      updateBuffer((s) => moveUp(s));
      return;
    }

    if (key.downArrow) {
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

    if (input.startsWith("")) {
      // Unhandled escape sequence (e.g. function keys); ignore to avoid inserting garbage.
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const sanitized = input.replace(/\r/g, "");
      updateBuffer((s) => insertText(s, sanitized));
    }
  }, { isActive: !disabled, stdout });

  function exitHistoryBrowsing(): void {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }

  function updateBuffer(updater: (state: PromptBufferState) => PromptBufferState): void {
    exitHistoryBrowsing();
    setBuffer(updater);
  }

  function navigateHistory(direction: -1 | 1): void {
    if (promptHistory.length === 0) {
      return;
    }

    const previousCursor = historyCursor === -1 ? promptHistory.length : historyCursor;
    const nextCursor = Math.max(0, Math.min(promptHistory.length, previousCursor + direction));
    const draft = historyCursor === -1 ? buffer.text : draftBeforeHistory;

    if (historyCursor === -1) {
      setDraftBeforeHistory(buffer.text);
    }

    if (nextCursor === promptHistory.length) {
      const text = draft ?? "";
      setBuffer({ text, cursor: text.length });
      setHistoryCursor(-1);
      setDraftBeforeHistory(null);
      return;
    }

    const text = promptHistory[nextCursor] ?? "";
    setBuffer({ text, cursor: direction < 0 ? 0 : text.length });
    setHistoryCursor(nextCursor);
  }

  function handleSlashSelection(item: SlashCommandItem): void {
    if (busy && item.kind !== "exit") {
      setStatusMessage("请等待当前响应完成，或按 Esc 中断");
      return;
    }

    if (item.kind === "skill" && item.skill) {
      addSelectedSkill(item.skill);
      clearSlashToken();
      setShowSkillsDropdown(false);
      return;
    }
    if (item.kind === "skills") {
      clearSlashToken();
      setShowSkillsDropdown(true);
      return;
    }
    if (item.kind === "model") {
      clearSlashToken();
      setModelDropdownIndex(0);
      setShowModelDropdown(true);
      return;
    }
    if (item.kind === "thinking") {
      clearSlashToken();
      setThinkingMenuIndex(0);
      setShowThinkingMenu(true);
      return;
    }
    if (item.kind === "autoSwitch") {
      clearSlashToken();
      const newMode = activeMode === "auto" ? "pro" : "auto";
      onAutoSwitchChange(newMode);
      setStatusMessage(newMode === "auto" ? "自动切换已开启" : "自动切换已关闭");
      return;
    }
    if (item.kind === "verbose") {
      clearSlashToken();
      const newVerbose = !verboseMode;
      onVerboseChange(newVerbose);
      setStatusMessage(newVerbose ? "详细模式已开启（展示思考过程和工具调用历史）" : "详细模式已关闭");
      return;
    }
    if (item.kind === "new") {
      // Reset local state first, then notify parent — the parent changes
      // staticKey which unmounts this PromptInput, so no setState should
      // happen after onSubmit to avoid React warnings.
      setBuffer(EMPTY_BUFFER);
      setImageUrls([]);
      setSelectedSkills([]);
      setShowSkillsDropdown(false);
      onSubmit({ text: "", imageUrls: [], command: "new" });
      return;
    }
    if (item.kind === "resume") {
      setBuffer(EMPTY_BUFFER);
      setImageUrls([]);
      setSelectedSkills([]);
      setShowSkillsDropdown(false);
      onSubmit({ text: "", imageUrls: [], command: "resume" });
      return;
    }
    if (item.kind === "exit") {
      onSubmit({ text: "", imageUrls: [], command: "exit" });
      return;
    }
    if (item.kind === "learn") {
      clearSlashToken();
      const learnPrompt = [
        "请回顾本轮对话，从以下维度反思并总结改进经验：",
        "",
        "1. 工具调用失败 — exitCode 非零、rtk 拦截、空结果、超时等",
        "2. 工具选择 — 是否用了最优工具？（如：该用 gitnexus_query 却用了 grep）",
        "3. 重复调用 — 是否多次调用同一工具获取相同信息？",
        "4. 违反规则 — 是否违反了 AGENTS.md 或系统 prompt 中的已知规则？",
        "5. 推理冗余 — 是否探索了错误方向、做了无用功？",
        "6. 并行机会 — 是否有本可并行的调用却串行执行了？",
        "7. 上下文浪费 — 是否读取了大量无关文件，挤压了有效上下文？",
        "8. 更优方案 — 如果换一种思路，是否能更高效地完成任务？",
        "",
        "步骤：",
        "1. 先用 read 读取 AGENTS.md 的《实战经验手册》，了解已有条目，避免重复",
        "2. 回顾本轮对话，逐维度检查",
        "3. 将新模式总结为经验条目（沿用现有格式：现象、原因、解决）",
        "4. 用 edit 追加到《实战经验手册》末尾",
        "",
        "只总结本轮新出现的、尚未被记录的模式。",
        "修改后的 AGENTS.md 将在下一个新会话中生效。"
      ].join("\n");
      onSubmit({ text: learnPrompt, imageUrls: [], selectedSkills: [] });
      return;
    }
    if (item.kind === "worklog") {
      clearSlashToken();
      const worklogPrompt = [
        "请回顾本轮对话，将决策过程总结为工作日志文档。",
        "",
        "步骤：",
        "1. 先 read 一份现有文档（如 docs/developers/worklogs 下任一 .md）了解格式",
        "2. 回顾本轮对话，梳理关键决策点：",
        "   - 遇到了什么问题？",
        "   - 考虑了哪些方案？各自的优缺点？",
        "   - 最终选了哪个方案？为什么？",
        "   - 涉及哪些文件修改？",
        "3. 按以下结构组织文档：",
        "   - 标题（概括主题）",
        "   - 一句话概述",
        "   - 一、问题背景（含表格）",
        "   - 二、决策思路（含方案对比表：方案 | 描述 | 优点 | 缺点）",
        "   - 三、方案设计（含代码片段）",
        "   - 四、文件修改统计",
        "   - 五、相关文件",
        "4. 文件名格式：主题关键词 - 决策记录.md",
        "5. 用 write 写入 docs/developers/worklogs/ 目录",
        "",
        "注意：已有文档中记录过的决策不再重复；只总结本轮新决策。"
      ].join("\n");
      onSubmit({ text: worklogPrompt, imageUrls: [], selectedSkills: [] });
      return;
    }
  }

  function submitCurrentBuffer(): void {
    if (busy) {
      setStatusMessage("请等待当前响应完成，或按 Esc 中断");
      return;
    }

    const trimmed = buffer.text.trim();
    if (!trimmed && imageUrls.length === 0 && selectedSkills.length === 0) {
      return;
    }

    if (trimmed.startsWith("/")) {
      const exactMatch = findExactSlashCommand(slashItems, trimmed.split(/\s+/, 1)[0]);
      if (exactMatch) {
        handleSlashSelection(exactMatch);
        return;
      }
    }

    onSubmit({
      text: buffer.text,
      imageUrls,
      selectedSkills
    });
    setBuffer(EMPTY_BUFFER);
    setImageUrls([]);
    setSelectedSkills([]);
    setShowSkillsDropdown(false);
  }

  function addSelectedSkill(skill: SkillInfo): void {
    setSelectedSkills((prev) => addUniqueSkill(prev, skill));
  }

  function toggleSelectedSkill(skill: SkillInfo): void {
    setSelectedSkills((prev) => toggleSkillSelection(prev, skill));
  }

  function clearSlashToken(): void {
    exitHistoryBrowsing();
    setBuffer((state) => removeCurrentSlashToken(state));
  }

  const divider = "─".repeat(screenWidth);
  const visibleSkillStart = Math.min(
    Math.max(0, skillsDropdownIndex - 7),
    Math.max(0, skills.length - 8)
  );
  const visibleSkills = skills.slice(visibleSkillStart, visibleSkillStart + 8);

  return (
    <Box flexDirection="column">
      {imageUrls.length > 0 ? (
        <Box>
          <Text color="magenta">{formatImageAttachmentStatus(imageUrls.length)}</Text>
          <Text dimColor>{` (${IMAGE_ATTACHMENT_CLEAR_HINT})`}</Text>
        </Box>
      ) : null}
      {selectedSkills.length > 0 ? (
        <Box>
          <Text color="magenta" wrap="truncate-end">{formatSelectedSkillsStatus(selectedSkills)}</Text>
          <Text dimColor> (使用 /skills 编辑)</Text>
        </Box>
      ) : null}
      {showSkillsDropdown ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta" bold>选择技能</Text>
          {skills.length === 0 ? (
            <Text dimColor>未找到可用技能</Text>
          ) : (
            visibleSkills.map((skill, idx) => {
              const skillIndex = visibleSkillStart + idx;
              const selected = isSkillSelected(selectedSkills, skill);
              const active = skillIndex === skillsDropdownIndex;
              return (
                <Text key={skill.path || skill.name} color={active ? "cyanBright" : undefined} wrap="truncate-end">
                  {active ? "► " : "  "}
                  {selected ? "●" : "○"}{" "}
                  <Text bold>{skill.name}</Text>
                  {skill.isLoaded ? <Text color="green">  ✓</Text> : null}
                  <Text dimColor>{`  ${skill.path}`}</Text>
                </Text>
              );
            })
          )}
          {visibleSkillStart > 0 ? <Text dimColor>… {visibleSkillStart} above</Text> : null}
          {visibleSkillStart + visibleSkills.length < skills.length ? (
            <Text dimColor>… {skills.length - visibleSkillStart - visibleSkills.length} more</Text>
          ) : null}
          <Text dimColor>空格: 切换选择 · Enter: 切换选择 · Esc: 关闭</Text>
        </Box>
      ) : null}
      {showModelDropdown ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan" bold>切换模型</Text>
          {modelList.length === 0 ? (
            <Text dimColor>未配置任何模型</Text>
          ) : (
            modelList.map((name, idx) => {
              const active = idx === modelDropdownIndex;
              const isCurrent = name === activeModel;
              const provider = getModelProviderLabel(name);
              return (
                <Text key={name} color={active ? "cyanBright" : undefined} wrap="truncate-end">
                  {active ? "► " : "  "}
                  {isCurrent ? "●" : "○"}{" "}
                  <Text bold>{name}</Text>
                  {provider ? <Text dimColor>{`  ${provider}`}</Text> : null}
                  {isCurrent ? <Text color="green">  (当前)</Text> : null}
                </Text>
              );
            })
          )}
          <Text dimColor>Enter/空格: 选择 · Esc: 关闭</Text>
        </Box>
      ) : null}
      {showThinkingMenu ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow" bold>切换思考模式</Text>
          {buildThinkingOptions(activeThinking, activeReasoningEffort).map((option, idx) => {
            const active = idx === thinkingMenuIndex;
            const selected = option.kind === "toggle"
              ? activeThinking
              : option.kind === "effort" && option.value === activeReasoningEffort && activeThinking;
            return (
              <Text key={option.label} color={active ? "cyanBright" : undefined} wrap="truncate-end">
                {active ? "► " : "  "}
                {selected ? "●" : "○"}{" "}
                <Text bold>{option.label}</Text>
                {option.detail ? <Text dimColor>{`  ${option.detail}`}</Text> : null}
                {option.kind === "toggle" && activeThinking ? <Text color="green">  (当前)</Text> : null}
                {option.kind === "toggle" && !activeThinking ? <Text color="green">  (当前)</Text> : null}
              </Text>
            );
          })}
          <Text dimColor>Enter/空格: 切换/选择 · Esc: 关闭</Text>
        </Box>
      ) : null}
      {showMenu ? (
        <Box flexDirection="column" marginBottom={1}>
          {slashMenu.slice(0, 12).map((item, idx) => (
            <Text key={item.label} color={idx === menuIndex ? "cyanBright" : undefined} wrap="truncate-end">
              {idx === menuIndex ? "► " : "  "}
              <Text bold>{formatSlashCommandLabel(item)}</Text>
              <Text dimColor>  {formatSlashCommandDescription(item.description)}</Text>
            </Text>
          ))}
          {slashMenu.length > 12 ? <Text dimColor>… {slashMenu.length - 12} more</Text> : null}
        </Box>
      ) : null}
      <Text dimColor>{divider}</Text>
      <Box>
        <Text color={busy ? "yellow" : "green"}>{promptPrefix}</Text>
        <Text>{renderBufferWithCursor(buffer, !disabled && hasTerminalFocus)}</Text>
      </Box>
      <Text dimColor>{divider}</Text>
      <Box>
        <Text dimColor>{footerText}</Text>
      </Box>
    </Box>
  );
}

export const IMAGE_ATTACHMENT_CLEAR_HINT = "Ctrl+X 清除图片";

export function formatImageAttachmentStatus(count: number): string {
  if (count <= 0) {
    return "";
  }
  return `📎 ${count} image${count === 1 ? "" : "s"} attached`;
}

export function formatSelectedSkillsStatus(skills: SkillInfo[]): string {
  const names = skills.map((skill) => skill.name).filter(Boolean);
  if (names.length === 0) {
    return "";
  }
  return `⚡ ${names.join(", ")}`;
}

export function isSkillSelected(skills: SkillInfo[], skill: SkillInfo): boolean {
  return skills.some((item) => item.name === skill.name);
}

export function addUniqueSkill(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  if (isSkillSelected(skills, skill)) {
    return skills;
  }
  return [...skills, skill];
}

export function toggleSkillSelection(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  return isSkillSelected(skills, skill)
    ? skills.filter((item) => item.name !== skill.name)
    : [...skills, skill];
}

type ThinkingOption = {
  kind: "toggle" | "effort";
  label: string;
  detail?: string;
  value?: ReasoningEffort;
};

function buildThinkingOptions(
  activeThinking: boolean,
  activeReasoningEffort: ReasoningEffort
): ThinkingOption[] {
  return [
    { kind: "toggle", label: activeThinking ? "关闭思考模式" : "开启思考模式", detail: activeThinking ? "当前已开启" : "当前已关闭" },
    { kind: "effort", label: "努力度: max", detail: "最大推理深度", value: "max" },
    { kind: "effort", label: "努力度: high", detail: "深度推理，略低于 max", value: "high" },
  ];
}

export function removeCurrentSlashToken(state: PromptBufferState): PromptBufferState {
  let start = state.cursor;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) {
    start -= 1;
  }

  const token = state.text.slice(start, state.cursor);
  if (!token.startsWith("/")) {
    return state;
  }

  const text = `${state.text.slice(0, start)}${state.text.slice(state.cursor)}`;
  return { text, cursor: start };
}

export function isClearImageAttachmentsShortcut(input: string, key: Pick<InputKey, "ctrl">): boolean {
  return key.ctrl && (input === "x" || input === "X");
}

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
  isActive: boolean
): void {
  const directWriteRef = useRef<((data: string) => void) | null>(null);
  const activePlacementRef = useRef<CursorPlacement | null>(null);

  useLayoutEffect(() => {
    if (!stdout?.isTTY) {
      return;
    }

    const stream = stdout as NodeJS.WriteStream & { write: WriteFn };
    const originalWrite = stream.write;
    const directWrite = (data: string) => {
      originalWrite.call(stdout, data);
    };
    const restorePromptCursor = () => {
      const activePlacement = activePlacementRef.current;
      if (!activePlacement) {
        return;
      }
      directWrite("\r" + cursorDown(activePlacement.rowsUp) + hideCursor());
      activePlacementRef.current = null;
    };
    const patchedWrite: WriteFn = (...args) => {
      restorePromptCursor();
      return originalWrite.apply(stdout, args);
    };

    directWriteRef.current = directWrite;
    stream.write = patchedWrite;

    return () => {
      restorePromptCursor();
      stream.write = originalWrite;
      directWriteRef.current = null;
    };
  }, [stdout]);

  useLayoutEffect(() => {
    if (!isActive || !stdout?.isTTY) {
      return;
    }

    const directWrite = directWriteRef.current;
    if (!directWrite) {
      return;
    }

    directWrite(showCursor() + cursorUp(placement.rowsUp) + "\r" + cursorForward(placement.column));
    activePlacementRef.current = placement;

    return () => {
      const activePlacement = activePlacementRef.current;
      if (!activePlacement) {
        return;
      }
      directWrite("\r" + cursorDown(activePlacement.rowsUp) + hideCursor());
      activePlacementRef.current = null;
    };
  }, [isActive, placement.column, placement.rowsUp, stdout]);
}

function useTerminalFocusReporting(stdout: NodeJS.WriteStream | undefined, isActive: boolean): void {
  useLayoutEffect(() => {
    if (!isActive || !stdout?.isTTY) {
      return;
    }

    stdout.write(enableTerminalFocusReporting());
    return () => {
      stdout.write(disableTerminalFocusReporting());
    };
  }, [isActive, stdout]);
}

export function getPromptCursorPlacement(
  state: PromptBufferState,
  screenWidth: number,
  promptPrefix: string,
  footerText: string
): CursorPlacement {
  const width = Math.max(1, screenWidth);
  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  const beforeCursor = state.text.slice(0, cursor);
  const at = state.text[cursor];
  const displayText = beforeCursor + (typeof at === "undefined" || at === "\n" ? " " : at) +
    (at === "\n" ? "\n" : "") + (typeof at === "undefined" ? "" : state.text.slice(cursor + 1));

  const cursorPosition = measureTextPosition(beforeCursor, width, textWidth(promptPrefix));
  const promptRows = measureTextRows(displayText, width, textWidth(promptPrefix));
  const footerRows = 1 + measureTextRows(footerText, width, 0);

  return {
    rowsUp: (promptRows - 1 - cursorPosition.row) + footerRows + 1,
    column: cursorPosition.column
  };
}

function measureTextRows(text: string, width: number, initialColumn: number): number {
  return measureTextPosition(text, width, initialColumn).row + 1;
}

function measureTextPosition(text: string, width: number, initialColumn: number): { row: number; column: number } {
  let row = 0;
  let column = Math.min(initialColumn, width - 1);

  for (const char of Array.from(text)) {
    if (char === "\n") {
      row++;
      column = Math.min(initialColumn, width - 1);
      continue;
    }

    const charColumns = textWidth(char);
    if (column + charColumns > width) {
      row++;
      column = Math.min(initialColumn, width - 1);
    }
    column += charColumns;
    if (column >= width) {
      row++;
      column = Math.min(initialColumn, width - 1);
    }
  }

  return { row, column };
}

function textWidth(value: string): number {
  let width = 0;
  for (const char of Array.from(value.normalize())) {
    width += characterWidth(char);
  }
  return width;
}

function characterWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (codePoint >= 0x300 && codePoint <= 0x36f) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function cursorUp(rows: number): string {
  return rows > 0 ? `\u001B[${rows}A` : "";
}

function cursorDown(rows: number): string {
  return rows > 0 ? `\u001B[${rows}B` : "";
}

function cursorForward(columns: number): string {
  return columns > 0 ? `\u001B[${columns}C` : "";
}

function showCursor(): string {
  return "\u001B[?25h";
}

function hideCursor(): string {
  return "\u001B[?25l";
}

function enableTerminalFocusReporting(): string {
  return "\u001B[?1004h";
}

function disableTerminalFocusReporting(): string {
  return "\u001B[?1004l";
}

export function renderBufferWithCursor(state: PromptBufferState, isFocused: boolean): string {
  const text = state.text || "";
  const cursor = Math.max(0, Math.min(state.cursor, text.length));
  const before = text.slice(0, cursor);
  const at = text[cursor];
  const after = text.slice(cursor + 1);
  if (!isFocused) {
    return text.endsWith("\n") ? `${text} ` : text;
  }

  if (typeof at === "undefined") {
    return before + chalk.inverse(" ");
  }
  if (at === "\n") {
    return before + chalk.inverse(" ") + "\n" + after;
  }
  return before + chalk.inverse(at) + after;
}

export function useTerminalInput(
  inputHandler: (input: string, key: InputKey) => void,
  options: { isActive?: boolean; stdout?: NodeJS.WriteStream } = {}
): void {
  const { stdin, setRawMode, internal_exitOnCtrlC } = useStdin();
  const isActive = options.isActive ?? true;

  useEffect(() => {
    if (!isActive) {
      return;
    }
    setRawMode(true);
    // Enable bracketed paste mode so pasted text is wrapped in
    // \u001B[200~...\u001B[201~, preventing line-ending characters like
    // \r from being misinterpreted as keystrokes.
    if (options.stdout?.isTTY) {
      options.stdout.write("\u001B[?2004h");
    }
    return () => {
      setRawMode(false);
      if (options.stdout?.isTTY) {
        options.stdout.write("\u001B[?2004l");
      }
    };
  }, [isActive, setRawMode, options.stdout]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const NO_MODIFIERS: InputKey = {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      pageDown: false,
      pageUp: false,
      return: false,
      escape: false,
      ctrl: false,
      shift: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      focusIn: false,
      focusOut: false
    };

    let pasteBuffer = "";
    let isPasting = false;

    const processNormal = (raw: string): void => {
      const { input, key } = parseTerminalInput(raw);
      if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
        inputHandler(input, key);
      }
    };

    const handleData = (data: Buffer | string): void => {
      const raw = String(data);

      // Bracketed paste mode: pasted content is wrapped in
      // \u001B[200~...\u001B[201~ by the terminal.
      if (isPasting) {
        const endIdx = raw.indexOf("\u001B[201~");
        if (endIdx >= 0) {
          pasteBuffer += raw.slice(0, endIdx);
          isPasting = false;
          // Convert \r\n (and standalone \r) to \n so pasted multi-line
          // text is treated as a single insertion rather than multiple submits.
          const cleaned = pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          if (cleaned) {
            // Insert the entire pasted text at once with no modifiers,
            // so it flows through to insertText in the input handler.
            inputHandler(cleaned, NO_MODIFIERS);
          }
          pasteBuffer = "";
          // Process any data that followed the end marker
          const remaining = raw.slice(endIdx + 6);
          if (remaining) {
            processNormal(remaining);
          }
        } else {
          pasteBuffer += raw;
        }
        return;
      }

      if (raw.startsWith("\u001B[200~")) {
        isPasting = true;
        pasteBuffer = "";
        const afterStart = raw.slice(6); // "\u001B[200~".length === 6
        if (afterStart) {
          handleData(afterStart); // Re-enter to check for end marker
        }
        return;
      }

      processNormal(raw);
    };

    stdin?.on("data", handleData);
    return () => {
      stdin?.off("data", handleData);
    };
  }, [isActive, stdin, internal_exitOnCtrlC, inputHandler]);
}

export function parseTerminalInput(data: Buffer | string): { input: string; key: InputKey } {
  const raw = String(data);
  let input = raw;
  const key: InputKey = {
    upArrow: raw === "\u001B[A",
    downArrow: raw === "\u001B[B",
    leftArrow: raw === "\u001B[D" || CTRL_LEFT_SEQUENCES.has(raw) || META_LEFT_SEQUENCES.has(raw),
    rightArrow: raw === "\u001B[C" || CTRL_RIGHT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw),
    home: HOME_SEQUENCES.has(raw),
    end: END_SEQUENCES.has(raw),
    pageDown: raw === "\u001B[6~",
    pageUp: raw === "\u001B[5~",
    return: raw === "\r" || SHIFT_RETURN_SEQUENCES.has(raw) || META_RETURN_SEQUENCES.has(raw),
    escape: raw === "\u001B",
    ctrl: CTRL_LEFT_SEQUENCES.has(raw) || CTRL_RIGHT_SEQUENCES.has(raw),
    shift: SHIFT_RETURN_SEQUENCES.has(raw),
    tab: raw === "\t" || raw === "\u001B[Z",
    backspace: BACKSPACE_BYTES.has(raw),
    delete: FORWARD_DELETE_SEQUENCES.has(raw),
    meta: META_LEFT_SEQUENCES.has(raw) || META_RIGHT_SEQUENCES.has(raw) || META_RETURN_SEQUENCES.has(raw),
    focusIn: raw === TERMINAL_FOCUS_IN,
    focusOut: raw === TERMINAL_FOCUS_OUT
  };

  if (input <= "\u001A" && !key.return) {
    input = String.fromCharCode(input.charCodeAt(0) + "a".charCodeAt(0) - 1);
    key.ctrl = true;
  }

  const isKnownEscapeSequence =
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.home ||
    key.end ||
    key.pageDown ||
    key.pageUp ||
    key.tab ||
    key.delete ||
    key.return ||
    key.ctrl ||
    key.meta ||
    key.focusIn ||
    key.focusOut;

  if (raw.startsWith("\u001B")) {
    input = raw.slice(1);
    key.meta = key.meta || !isKnownEscapeSequence;
  }

  const isLatinUppercase = input >= "A" && input <= "Z";
  const isCyrillicUppercase = input >= "А" && input <= "Я";
  if (input.length === 1 && (isLatinUppercase || isCyrillicUppercase)) {
    key.shift = true;
  }

  if (key.tab && input === "[Z") {
    key.shift = true;
  }

  if (key.tab || key.backspace || key.delete) {
    input = "";
  }

  return { input, key };
}
