/** 模式切换栏组件：模型选择、思考模式、详细模式、自动切换开关 */
import React from "react";
import { Box, Text } from "ink";
import type { ReasoningEffort } from "../settings";
import type { SkillInfo } from "../session";

type Props = {
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
  busy: boolean;
  loadingText?: string | null;
};

/** 思考模式选项定义 */
type ThinkingOption = {
  kind: "toggle" | "effort";
  label: string;
  detail?: string;
  value?: ReasoningEffort;
};

function buildThinkingOptions(
  activeThinking: boolean,
  activeReasoningEffort: ReasoningEffort,
): ThinkingOption[] {
  return [
    { kind: "toggle", label: activeThinking ? "关闭思考模式" : "开启思考模式", detail: activeThinking ? "当前已开启" : "当前已关闭" },
    { kind: "effort", label: "努力度: max", detail: "最大推理深度", value: "max" },
    { kind: "effort", label: "努力度: high", detail: "深度推理，略低于 max", value: "high" },
  ];
}

/** 模型下拉菜单 */
export function ModelDropdown({
  modelList,
  selectedIndex,
  onSelect,
  onClose,
}: {
  modelList: string[];
  selectedIndex: number;
  onSelect: (model: string) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow" bold>切换模型</Text>
      {modelList.map((model, idx) => (
        <Text
          key={model}
          color={idx === selectedIndex ? "cyanBright" : undefined}
          wrap="truncate-end"
        >
          {idx === selectedIndex ? "► " : "  "}
          {model}
        </Text>
      ))}
      <Text dimColor>↑/↓: 选择 · Enter: 确认 · Esc: 关闭</Text>
    </Box>
  );
}

/** 思考模式菜单 */
export function ThinkingMenu({
  activeThinking,
  activeReasoningEffort,
  selectedIndex,
  onToggle,
  onClose,
}: {
  activeThinking: boolean;
  activeReasoningEffort: ReasoningEffort;
  selectedIndex: number;
  onToggle: (thinkingEnabled: boolean, reasoningEffort?: ReasoningEffort) => void;
  onClose: () => void;
}): React.ReactElement {
  const options = buildThinkingOptions(activeThinking, activeReasoningEffort);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow" bold>切换思考模式</Text>
      {options.map((option, idx) => {
        const active = idx === selectedIndex;
        const selected = option.kind === "toggle"
          ? activeThinking
          : option.kind === "effort" && option.value === activeReasoningEffort && activeThinking;
        return (
          <Text key={option.label} color={active ? "cyanBright" : undefined} wrap="truncate-end">
            {active ? "► " : "  "}
            {selected ? "●" : "○"}{" "}
            <Text bold>{option.label}</Text>
            {option.detail ? <Text dimColor>{`  ${option.detail}`}</Text> : null}
            {option.kind === "toggle" ? <Text color="green">  (当前)</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>Enter/空格: 切换/选择 · Esc: 关闭</Text>
    </Box>
  );
}

/** 技能下拉菜单 */
export function SkillsDropdown({
  skills,
  selectedIndex,
  selectedSkills,
  onToggle,
  onClose,
}: {
  skills: SkillInfo[];
  selectedIndex: number;
  selectedSkills: SkillInfo[];
  onToggle: (skill: SkillInfo) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow" bold>选择要加载的技能 (空格切换 · Enter 确认 · Esc 关闭)</Text>
      {skills.map((skill, idx) => {
        const isSelected = selectedSkills.some((s) => s.name === skill.name);
        return (
          <Text
            key={skill.name}
            color={idx === selectedIndex ? "cyanBright" : undefined}
            wrap="truncate-end"
          >
            {idx === selectedIndex ? "► " : "  "}
            {isSelected ? "●" : "○"}{" "}
            <Text bold>{skill.name}</Text>
            {skill.description ? <Text dimColor>  {skill.description}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

/** 状态栏：显示加载状态、模型、思考模式等信息 */
export function ModeStatusBar({
  busy,
  loadingText,
  activeModel,
  activeThinking,
  activeReasoningEffort,
  verboseMode,
  activeMode,
}: {
  busy: boolean;
  loadingText?: string | null;
  activeModel: string;
  activeThinking: boolean;
  activeReasoningEffort: ReasoningEffort;
  verboseMode: boolean;
  activeMode: string;
}): React.ReactElement {
  const text = busy
    ? loadingText && loadingText.trim()
      ? `${loadingText} · model: ${activeModel}`
      : `Esc: 中断响应 · Ctrl+C: 取消输入 · model: ${activeModel}`
    : `Ctrl+Z: 撤销输入 · Enter: 发送 · Shift+Enter: 换行 · Ctrl+V: 粘贴图片 · /: 命令菜单 · Ctrl+D: 退出 · model: ${activeModel} · thinking: ${activeThinking ? activeReasoningEffort : "off"} · verbose: ${verboseMode ? "on" : "off"} · autoSwitch: ${activeMode === "auto" ? "on" : "off"}`;

  return (
    <Text color={busy ? "yellow" : undefined} dimColor={!busy} wrap="truncate-end">{text}</Text>
  );
}
