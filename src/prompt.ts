import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionMessage, SkillInfo } from "./session";

export const AGENT_DRIFT_GUARD_SKILL = `
---
name: agent-drift-guard
description: 在执行用户请求时检测并纠正执行漂移。当你正积极实现、调试、审查或调查，存在偏离用户目标、添加未请求的工作、触碰在线系统、过度探索或忽略用户重复的边界纠正的风险时使用。特别适用于多步骤编码任务、生产环境相关请求、模糊范围，以及任何你应该自我检查是否仍在解决所请求问题的时候。
---

# Agent Drift Guard

保持执行与用户的实际请求紧密对齐。

## Quick Start

在进行实质性工作之前以及计划扩大时，运行此心智检查：

1. 用一句话表述用户请求的结果。
2. 列出用户已设定的明确非目标或边界。
3. 询问下一个操作是否直接推进所请求的结果。
4. 如果不是，要么裁减它，要么暂停确认。

## 漂移信号

将这些视为执行可能正在漂移的警告信号：

- 在打开最相关的文件、命令或产物之前先广泛探索。
- 当用户只要求代码更改时，解决相邻的操作性问题。
- 添加用户未要求的额外安全措施、脚本、文档、重构或清理。
- 将任务重新定义为看似"更好"的内容，而不是所请求的内容。
- 在用户缩小范围后继续执行更广泛的计划。
- 重复搜索或工具调用而没有提高确定性。
- 当用户只要求其中一项时，混合诊断、修复和功能开发。
- 未经明确许可触碰类似生产环境的状态、外部系统或实时数据。

## 严重级别

### 级别 1：轻度漂移

示例：
- 一两个额外的探索性命令。
- 考虑更广泛的解决方案但尚未采取行动。
- 过度解释而非推进任务。

响应：
- 自动静默纠正。
- 缩小到最小的下一个操作。
- 不要中断用户。

### 级别 2：实质性漂移

示例：
- 规划未请求的额外交付物。
- 在被问及的范围之外编写辅助脚本、迁移、文档或测试。
- 从代码更改扩展到运维修复。
- 在用户已纠正范围一次后继续。

响应：
- 首先停止并在内部重新对齐。
- 如果更广泛的行动可以避免，放弃它并继续在范围内工作。
- 如果更广泛的行动有非明显的权衡，提出简短的确认问题。

### 级别 3：边界或风险违规

示例：
- 未经要求修改在线系统、生产数据、外部服务或用户拥有的状态。
- 在所请求范围之外采取破坏性或难以逆转的操作。
- 忽略关于什么不应该做的重复用户指示。

响应：
- 在行动前暂停。
- 暴露确切边界并请求确认。
- 首先提供最小的范围内选项。

## 自检循环

在执行过程中使用此循环：

### 在第一个有意义操作之前

在脑海中写下：
- 请求的结果
- 允许的范围
- 禁止的范围
- 最小的有用下一步

### 在每个重要步骤之后

询问：
- 这一步是否直接帮助交付了所请求的结果？
- 我学到的东西是否改变了范围，还是仅仅改变了实现？
- 我是否即将做比用户要求更多的事情？

### 在用户纠正之后

将纠正视为硬边界更新。

然后：
- 移除旧的更广泛的计划。
- 不要为已放弃的工作辩护。
- 从缩小的范围继续。
- 如果需要，简短确认后继续前进。

## 决策规则

按顺序使用这些规则：

1. 优先选择最直接的产物。
   - 在扫描整个仓库之前先打开相关文件。
   - 在设计通用框架之前先检查具体的失败路径。

2. 优先选择最小的完整修复。
   - 在改进相关系统之前先解决被问及的问题。
   - 避免额外工作，除非它对正确性是必需的。

3. 优先内部纠正而非用户中断。
   - 如果你能自信地缩小回范围内，就去做。
   - 仅当下一步改变交付物、风险或所有权时才提问。

4. 将重复的用户约束视为优先级信号。
   - 重复的指令意味着你的执行风格目前不对齐。
   - 立即收紧范围。

5. 分离不同类型的工作。
   - 代码更改、调查、生产修复、清理和文档是不同的任务，除非用户明确将它们组合在一起。

## 良好的干预风格

当你必须暂停时，保持简短和具体：

- 用一句话说明潜在的漂移。
- 指出权衡或边界。
- 首先提供最小的范围内选项。

示例：

"快速对齐检查：我可以只做代码修复，或者也添加运维清理步骤。除非你两者都需要，否则我坚持只做代码修复。"

## 反模式

不要：

- 仅仅因为看起来有用就创建清理脚本、文档或辅助工具。
- 在发现相邻问题后扩大任务范围。
- 继续用户已拒绝的计划。
- 用"最佳实践"来为漂移辩护，而用户要求的是更窄的交付物。
- 将额外工作隐藏在更大的补丁中。

## 响应前的最终检查

在发送最终答案之前，验证：

- 交付的工作与请求的结果匹配。
- 没有未经确认添加额外交付物。
- 任何假设都已简要陈述。
- 建议的下一步是可选的，而不是捆绑到已完成的工作中。
`;

const COMPACT_PROMPT_BASE = `你的任务是对到目前为止的对话创建一份详细的摘要，密切注意用户的明确请求和你之前的操作。
该摘要应该全面捕获技术细节、代码模式和架构决策，这些对于在不丢失上下文的情况下继续开发工作至关重要。

在提供最终摘要之前，将你的分析包裹在 <analysis> 标签中以组织思路，并确保涵盖了所有必要的要点。在分析过程中：

1. 按时间顺序分析每条消息和每个对话段落。对于每个段落，全面识别：
   - 用户的明确请求和意图
   - 你对用户请求的处理方式
   - 关键决策、技术概念和代码模式
   - 具体细节，如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到的错误及修复方式
   - 特别注意你收到的具体用户反馈，尤其是用户告诉你要做不同的事情时。
2. 再次检查技术准确性和完整性，全面处理每个必需的元素。

你的摘要应包含以下部分：

1. 主要请求和意图：详细记录用户的所有明确请求和意图
2. 关键技术概念：列出所有讨论的重要技术概念、技术和框架。
3. 文件和代码部分：枚举检查、修改或创建的具体文件。特别注意最近的消息，在适用时包含完整的代码片段，并说明此文件读取或编辑为什么重要。
4. 错误和修复：列出你遇到的所有错误及修复方式。特别注意你收到的具体用户反馈，尤其是用户告诉你要做不同的事情时。
5. 问题解决：记录已解决的问题和任何正在进行的调试工作。
6. 所有用户消息：列出所有不是工具结果的用户消息。这些对于理解用户的反馈和意图变化至关重要。
7. 待办任务：概述你被明确要求处理的任何待办任务。
8. 当前工作：详细描述在此摘要请求之前正在处理的内容，特别注意用户和助手之间最近的消息。在适用时包含文件名和代码片段。
9. 可选的下一步：列出你将要采取的与最近工作相关的下一步。重要提示：确保此步骤**直接**符合用户最近的明确请求以及你在本摘要请求之前正在处理的任务。如果你的上一个任务已经完成，那么只有当后续步骤明确符合用户的请求时才列出它们。不要在未先与用户确认的情况下开始处理无关的请求或已经完成的旧请求。
                       如果有下一步，请包含最近对话中的直接引用，精确显示你正在处理什么任务以及在哪里中断了。这应该是逐字引用的，以确保任务解释没有漂移。

下面是一个输出结构示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被全面准确地涵盖]
</analysis>

<summary>
1. 主要请求和意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]
   - [...]

3. 文件和代码部分：
   - [文件名 1]
      - [此文件重要的原因摘要]
      - [对此文件所做的更改摘要（如果有）]
      - [重要代码片段]
   - [文件名 2]
      - [重要代码片段]
   - [...]

4. 错误和修复：
    - [错误 1 的详细描述]：
      - [修复方式]
      - [用户的反馈（如果有）]
    - [...]

5. 问题解决：
   [已解决的问题和正在进行的调试的描述]

6. 所有用户消息：
    - [详细的非工具使用用户消息]
    - [...]

7. 待办任务：
   - [任务 1]
   - [任务 2]
   - [...]

8. 当前工作：
   [当前工作的精确描述]

9. 可选的下一步：
   [可选的下一步]

</summary>`;

const SYSTEM_PROMPT_BASE = `你是一个交互式 CLI 工具，帮助用户完成软件工程任务。请使用下面的指令和可用的工具来协助用户。

重要提示：除非你确信 URL 有助于用户编程，否则**绝不**为用户生成或猜测 URL。你可以使用用户消息或本地文件中提供的 URL。

语言要求：**所有输出和思考过程都必须使用中文。** 无论用户使用什么语言提问，你的内部推理、工具调用描述和最终结论都使用中文。技术术语（如函数名、变量名、包名等）可保留原文。

输出规范：
- 在调用工具时，不要输出任何解释性文字。用户会在界面上看到每个步骤的指示器。
- 等所有工具调用执行完毕、得到全部结果之后，再一次性输出最终结论。
- 结论应简洁明了，概括做了什么、结果如何。`;

type PromptToolOptions = {
  webSearchEnabled?: boolean;
  /** 当 autoSwitch=on + model=Pro 时启用 Supervisor-Worker 委派模式 */
  supervisorMode?: boolean;
};

function readToolDocs(extensionRoot: string): string {
  const toolsDir = path.join(extensionRoot, "docs", "tools");
  if (!fs.existsSync(toolsDir)) {
    return "";
  }

  const entries = fs.readdirSync(toolsDir);
  const docs = entries
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => {
      const fullPath = path.join(toolsDir, entry);
      try {
        return fs.readFileSync(fullPath, "utf8").trim();
      } catch {
        return "";
      }
    })
    .filter((content) => content.length > 0);

  return docs.join("\n\n");
}

export function getSystemPrompt(projectRoot: string, options: PromptToolOptions = {}): string {
  const toolDocs = readToolDocs(getExtensionRoot());
  const basePrompt = toolDocs
    ? `${SYSTEM_PROMPT_BASE}\n\n# 可用工具\n\n${toolDocs}`
    : SYSTEM_PROMPT_BASE;
  const skillsIndex = getSkillsIndex(projectRoot);
  const supervisorExplorer = options.supervisorMode ? `\n\n${EXPLORER_GUIDANCE}` : "";
  // EXPLORER_GUIDANCE 放在 runtimeContext 之后，确保两种模式的公共前缀一致，避免跨模式缓存失效
  return `${basePrompt}${skillsIndex}\n\n${CODE_EXECUTOR_GUIDANCE}\n\n${getRuntimeContext(projectRoot)}${supervisorExplorer}`;
}

/** Supervisor-Worker 架构的行为指南，嵌入 system prompt。 */
const CODE_EXECUTOR_GUIDANCE = `# 代码修改策略（Supervisor-Worker 模式）

**硬约束：** 你必须将所有多文件或多处编辑委派出去。单次调用中绝不要调用 edit_file 超过一次。

## 决策树：直接编辑还是委派？

| 范围 | 操作 |
|---|---|
| 1 个文件，1-2 行（拼写、重命名） | 直接 edit_file |
| 1 个文件，3-20 行 | spawn_code_executor（1 个 file_path） |
| 2-5 个文件，独立修改 | 并行 spawn_code_executor × N（每个 Fixer 处理 1-2 个文件） |
| 3-5 个文件，需先理解代码 | spawn_explorer → review → spawn_code_executor |
| 6+ 个文件，跨模块重构 | 第一阶段：并行 2-3× spawn_explorer；第二阶段：review；第三阶段：并行 spawn_code_executor × N |
| 结构性问题（查找调用者、追踪调用链） | spawn_explorer —— 不要自己 grep+read 5+ 个文件 |

每个 Fixer（spawn_code_executor）有 12 次工具调用迭代。拆分任务使每个 Fixer 最多处理 1-3 个文件 —— 不要把 8 个文件塞进一个 Fixer。

## 工作流

1. **委派前先读取。** 先使用 read_file 获取足够上下文来编写精确指令。捕获外部类型定义，通过 context 字段传入。
2. **拆分大任务。** 涉及 3+ 个文件的修改，并行委派多个 Fixer，每个处理 1-2 个 file_path。跨文件一致性是你的职责 —— 审核结果。
3. **编写精确指令。** 子智能体没有对话上下文 —— 只有文件内容 + 你的指令。精确说明要改什么、怎么改。
4. **提供所需上下文。** 包含类型签名、导入路径、调用方示例等子智能体需要的信息。
5. **有风险的修改先请示。** 跨文件重构、删除超过 10 行、关键模块 → 先 AskUserQuestion。
6. **委派后验证。**
   - 成功 → 用 read_file 验证跨文件修改；单文件修改可信任。
   - 失败 → 根据 failureCode：NOT_FOUND/AMBIGUOUS → 重新读取后重新委派。API_ERROR → 重试一次。TIMEOUT/SCOPE_EXCEEDED → 拆分成更小的 Fixer。

当 \`spawn_code_executor\` 不可用时，直接按常规方式执行所有编辑。`;

/** Supervisor explorer delegation guidance — built-in explorer skill info added to skills index */
const EXPLORER_GUIDANCE = `# 探索策略（委派 Explorer）

**在你自己探索不熟悉的代码之前，先委派给 Flash Explorer。**

使用 \`spawn_explorer\` 的场景：
1. "查找 X 的所有调用者/引用" —— 一次 Explorer 调用 vs 5-8 轮 grep+read
2. "这个模块是怎么工作的" —— Explorer 用 GitNexus 绘制领域地图
3. "改这个会破坏什么" —— gitnexus_impact 影响分析
4. "追踪错误路径" —— gitnexus_processes 调用链追踪
5. "理解项目分层" —— gitnexus_clusters 概览

**工作流：**
- 独立的问题并行委派 2-3 个 Explorer
- 拿到结果后，只读 1-2 个最相关的文件确认，然后决策
- 信息不足时，用更精确的问题重新委派

**验证 Explorer 结果：**
- 信任但要验证 —— Explorer 可能遗漏间接调用者或缓存未命中
- 自己交叉检查 1-2 个关键文件（调用点、类型定义）
- 如果两个 Explorer 返回矛盾的结果，调查差异

**失败处理：**
- NOT_FOUND / AMBIGUOUS → 重新读取目标文件，用更精确的范围重新委派
- API_ERROR → 重试一次（瞬时故障）；持续失败则回退到直接探索
- TIMEOUT / SCOPE_EXCEEDED → 拆分成更小、单一问题的 Explorer 调用

不要自己读 5+ 个文件来回答结构性问题 —— 委派它。`;

export function getCompactPrompt(sessionMessages: SessionMessage[]): string {
  const jsonl = sessionMessages
    .map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        contentParams: message.contentParams,
        messageParams: message.messageParams,
        createTime: message.createTime
      })
    )
    .join("\n");
  return `${COMPACT_PROMPT_BASE}\n\n对话内容如下：\n\n\`\`\`jsonl\n${jsonl}\n\`\`\``;
}

function getRuntimeContext(projectRoot: string): string {
  const uname = getUnameInfo();
  const env = {
    "root path": projectRoot,
    pwd: projectRoot,
    homedir: os.homedir(),
    "system info": uname,
    "command installed": {
      "ast-grep": checkToolInstalled("ast-grep"),
      "ripgrep": checkToolInstalled("rg"),
      "jq": checkToolInstalled("jq")
    }
  };
  return `# 本地工作环境\n\n\`\`\`json
${JSON.stringify(env, null, 2)}
\`\`\``;
}

const SKILLS_INDEX_MAX_CHARS = 4000;

function getSkillsIndex(projectRoot: string): string {
  const skills = collectAllSkills(projectRoot);
  // 内置 Explorer skill
  skills.push({ name: "explore", path: "(builtin)", description: "以 Flash 子智能体探索代码库——GitNexus 导航式搜索，只返回精炼结论。 [Flash subagent]" });

  const lines = skills
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const desc = s.description || "(no description)";
      return `- ${s.name} — ${desc}`;
    });

  const joined = lines.join("\n");
  const truncated = joined.length > SKILLS_INDEX_MAX_CHARS
    ? `${joined.slice(0, SKILLS_INDEX_MAX_CHARS)}\n… (truncated ${joined.length - SKILLS_INDEX_MAX_CHARS} chars)`
    : joined;

  return [
    "",
    "# 可用技能",
    "",
    "一行索引。调用 `SkillLoad({ name: \"<skill-name>\" })` 加载完整技能体。",
    "```",
    truncated,
    "```",
  ].join("\n");
}

/** Collect all available skills from user-level and project-level directories.
 *  Mirrors SessionManager.listSkills() but stateless — only reads name+description+path. */
function collectAllSkills(projectRoot: string): SkillInfo[] {
  const homeDir = os.homedir();
  const roots: Array<{ dir: string; displayRoot: string }> = [
    { dir: path.join(homeDir, ".agents", "skills"), displayRoot: "~/.agents/skills" },
    { dir: path.join(projectRoot, ".deepseek-code", "skills"), displayRoot: "./.deepseek-code/skills" },
  ];

  const byName = new Map<string, SkillInfo>();

  for (const { dir, displayRoot } of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillName = entry.name;
      const skillPath = path.join(dir, skillName, "SKILL.md");
      try {
        if (!fs.existsSync(skillPath)) continue;
        const stat = fs.statSync(skillPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const raw = fs.readFileSync(skillPath, "utf8");
      const firstLine = raw.split("\n")[0] ?? "";
      const nameFromMd = firstLine.startsWith("# ") ? firstLine.slice(2).trim() : skillName;
      const descMatch = raw.match(/description:\s*(.+)/);
      const desc = descMatch ? descMatch[1]!.trim() : "";
      const runAsMatch = raw.match(/runAs:\s*(.+)/);
      const runAsTag = runAsMatch && runAsMatch[1]!.trim() === "subagent" ? " [Flash subagent]" : "";
      const displayPath = `${displayRoot}/${skillName}/SKILL.md`;
      if (!byName.has(nameFromMd)) {
        byName.set(nameFromMd, { name: nameFromMd, path: displayPath, description: desc + runAsTag });
      }
    }
  }

  return Array.from(byName.values());
}

function checkToolInstalled(tool: string): boolean {
  try {
    execSync(`command -v ${tool}`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getUnameInfo(): string {
  try {
    return execSync("uname -a", { encoding: "utf8" }).trim();
  } catch {
    return `${os.type()} ${os.release()} ${os.arch()}`;
  }
}

function getExtensionRoot(): string {
  return path.resolve(__dirname, "..");
}

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export function getTools(_options: PromptToolOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "在持久化的 bash 会话中执行 shell 命令。",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "要执行的 shell 命令",
            },
            description: {
              type: "string",
              description:
                '用主动语态清晰简洁地描述此命令的作用。不要在描述中使用"复杂"或"风险"这样的词——只要描述它做什么。',
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "AskUserQuestion",
        description:
          "当任务存在歧义或有多种实现方案时，使用此工具暂停执行并向用户提问，以获取澄清或做出决策。",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              description:
                "要呈现给用户的问题。通常一次只需要一个问题。",
              items: {
                type: "object",
                properties: {
                  question: {
                    type: "string",
                    description: "要向用户提出的问题。",
                  },
                  multiSelect: {
                    type: "boolean",
                    description:
                      "用户是否可以选择多个选项。",
                  },
                  options: {
                    type: "array",
                    description:
                      "供用户选择的预定义选项列表。",
                    items: {
                      type: "object",
                      properties: {
                        label: {
                          type: "string",
                          description:
                            "选项的显示文本。",
                        },
                        description: {
                          type: "string",
                          description:
                            "关于此选项的详细说明或提示，帮助用户了解选择后的结果。",
                        },
                      },
                      required: ["label"],
                    },
                  },
                },
                required: ["question", "options"],
              },
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read",
        description:
          "从文件系统读取文件（文本、图片、PDF、笔记本）。",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "文件的 UNIX 风格路径",
            },
            offset: {
              type: "number",
              description: "开始读取的行号",
            },
            limit: {
              type: "number",
              description: "要读取的行数",
            },
            pages: {
              type: "string",
              description:
                'PDF 文件的页码范围（例如 "1-5"、"3"、"10-20"）。仅适用于 PDF 文件。',
            },
          },
          required: ["file_path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description:
          "创建文件或用完整字符串内容覆写文件。优先使用 edit 编辑现有文件。",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "文件的绝对路径",
            },
            content: {
              type: "string",
              description: "完整的文件内容字符串。写入 JSON 前请先序列化完整文档。",
            },
          },
          required: ["file_path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "在文件中执行范围内字符串替换。",
        parameters: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "要修改的文件的绝对路径。当提供了 snippet_id 时可省略。",
            },
            snippet_id: {
              type: "string",
              description: "由 Read 或先前的 Edit 工具返回的 Snippet id，用于在部分读取后限定搜索范围。",
            },
            old_string: {
              type: "string",
              description: "要在文件或 snippet 范围内替换的确切文本",
            },
            new_string: {
              type: "string",
              description: "替换后的文本（必须与 old_string 不同）",
            },
            replace_all: {
              type: "boolean",
              description:
                "替换所有出现的 old_string（默认为 false）",
              default: false,
            },
            expected_occurrences: {
              type: "number",
              description:
                "预期的匹配次数，对 replace_all 来说是一个有用的安全保障",
            },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
  ];

  tools.push({
    type: "function",
    function: {
      name: "glob",
      description:
        "查找匹配 glob 模式的文件。返回匹配文件路径的列表。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              '用于匹配文件名的 glob 模式（例如 "**/*.ts"、"*.json"、"src/**/*.test.ts"）。',
          },
          path: {
            type: "string",
            description:
              "要搜索的目录。默认为项目根目录。",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "grep",
      description:
        "使用文本或正则表达式搜索文件内容。返回文件路径、行号和上下文行。非常适合在进行精确读取之前定位符号、函数或模式的位置。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "要在文件内容中搜索的文本或正则表达式模式。",
          },
          path: {
            type: "string",
            description:
              "要搜索的目录或文件路径。默认为项目根目录。",
          },
          include: {
            type: "string",
            description:
              '文件模式过滤器（例如 "*.ts"、"*.tsx,*.js"）。以逗号分隔。',
          },
          context: {
            type: "number",
            description:
              "每个匹配前后显示的上下文行数。默认为 2。",
            default: 2,
          },
          ignoreCase: {
            type: "boolean",
            description:
              "匹配时是否忽略大小写。默认为 false。",
            default: false,
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "WebSearch",
      description: "使用自然语言查询执行网络搜索。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "一个以清晰、具体的自然语言问题或陈述形式表达的搜索查询，包含关键上下文。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "SkillLoad",
      description:
        "按需加载 Skill。标注 [Flash subagent] 的 skill 在隔离的 Flash 子智能体中执行，只返回结论，不污染上下文。未标注的 skill 正文注入当前会话供你亲自执行。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill 名称，与 Available Skills 列表中列出的完全一致。区分大小写。",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "directory_tree",
      description:
        "以树形结构列出目录内容。必须查看目录结构时优先使用此工具，而非 bash ls。默认最大深度 3 层，跳过 . 开头的隐藏目录（.deepseek-code 除外）。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要列出的目录路径。默认为项目根目录。",
          },
          maxDepth: {
            type: "number",
            description: "最大递归深度。默认为 3。",
          },
        },
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "ask_choice",
      description:
        "向用户展示 2-6 个预定义选项，使用弹窗选择器。当用户需要在方案之间选择、或你要确认一个偏好决策时使用。支持多选和自定义答案。对于是/否问题或开放式文本输入，使用 AskUserQuestion。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "要呈现给用户的问题。",
          },
          options: {
            type: "array",
            description: "预定义选项（最多 6 个）。",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "短标识符（如 A、B、C）。如果省略，则自动分配。",
                },
                label: {
                  type: "string",
                  description: "选项显示文本。",
                },
                description: {
                  type: "string",
                  description: "选项说明或提示。",
                },
              },
              required: ["label"],
            },
          },
          multiSelect: {
            type: "boolean",
            description: "是否允许选择多个选项。默认 false。",
          },
          allowCustom: {
            type: "boolean",
            description: "用户是否可以输入自定义答案。默认 true。",
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "在一次原子操作中编辑多个文件。每次编辑可以替换文件中某个字符串的所有匹配项或仅首个匹配项。编辑按顺序应用：如果一次编辑失败，后续编辑仍会尝试。",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "要执行的编辑操作列表。",
            items: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "要编辑的文件绝对路径。",
                },
                old_string: {
                  type: "string",
                  description: "要替换的文本。",
                },
                new_string: {
                  type: "string",
                  description: "替换后的文本（必须与 old_string 不同）。",
                },
                replace_all: {
                  type: "boolean",
                  description: "替换所有匹配项。默认 false（仅首个）。",
                },
                expected_occurrences: {
                  type: "number",
                  description: "当 replace_all 为 true 时，预期的匹配次数——安全校验。",
                },
              },
              required: ["file_path", "old_string", "new_string"],
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "todo_write",
      description:
        "会话内轻量任务追踪。用于 3+ 步骤的任务，防止遗漏。每次调用替换整个列表。最多一个条目处于 in_progress 状态。传 [] 清空。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "任务列表。传 [] 清空。",
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "任务描述，用于 pending/completed 状态显示。命令式（如 'Add tests'）。",
                },
                activeForm: {
                  type: "string",
                  description: "in_progress 状态时的显示文本。使用进行时形式（如 'Adding tests'）。",
                },
                status: {
                  type: "string",
                  description: "pending / in_progress / completed",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "通过 HTTP 抓取 URL 的文本内容。使用 curl 获取，剥离 HTML 标签。用于读取文档、API 参考、issue 页面等。搜索用 WebSearch。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要抓取的 URL。必须以 http:// 或 https:// 开头。",
          },
          maxChars: {
            type: "number",
            description: "返回的最大字符数。默认 10000。",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "run_background",
      description:
        "启动后台 shell 命令执行。返回一个 job ID，可通过 job_output 查询输出，通过 list_jobs 查看所有任务。用于编译、运行测试、启动开发服务器等长时间运行的任务——这些不应阻塞主循环。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的 shell 命令。",
          },
          description: {
            type: "string",
            description: "任务的简短描述，用于 UI 显示。例如 'Running npm test'。",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "job_output",
      description:
        "获取后台任务的当前输出。如果任务仍在运行，返回迄今已捕获的输出。如果已完成，返回完整输出。",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "run_background 返回的任务 ID。",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "list_jobs",
      description: "列出当前会话中所有后台任务及其状态。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "stop_job",
      description: "停止正在运行的后台任务。发送 SIGTERM 信号终止进程。",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "run_background 返回的任务 ID。",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "search_files",
      description:
        "按文件名模式搜索文件。返回匹配文件路径列表。与 glob（按路径模式）和 grep（按内容）不同，search_files 专门搜索文件名包含指定文本的文件。对于'找包含 test 的文件'比 glob **/*test* 语义更清晰。",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "文件名中要匹配的文本。例如 'test' 匹配 test.ts, user.test.tsx, test-helper.js 等。",
          },
          path: {
            type: "string",
            description: "搜索起始目录。默认为项目根目录。",
          },
          caseSensitive: {
            type: "boolean",
            description: "是否区分大小写。默认 false。",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  });

  tools.push({
    type: "function",
    function: {
      name: "get_file_info",
      description:
        "获取文件或目录的元信息：大小、行数、修改时间、类型等。在 read 大文件之前先调用此工具判断是否需要全文读取，避免超出上下文窗口。",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "文件或目录的绝对路径。",
          },
        },
        required: ["file_path"],
        additionalProperties: false,
      },
    },
  });
  tools.push({
    type: "function",
    function: {
      name: "handle_read",
      description:
        "按之前 Read 工具返回的 snippet_id 读取文件的特定行范围。" +
        "文件未变时直接从内存缓存切片（零 I/O），文件变更时自动从磁盘回源。" +
        "跨 Turn 有效 —— 后续轮次无需重新 Read 全文件即可获取精确区域。",
      parameters: {
        type: "object",
        properties: {
          snippet_id: {
            type: "string",
            description: "由 Read 工具在 metadata.snippet.id 中返回的 snippet id。"
          },
          lines: {
            type: "string",
            description:
              '行范围，格式 "START-END"（如 "100-200"）或 "START-"（如 "100-" 默认 200 行窗口）。'
          }
        },
        required: ["snippet_id", "lines"],
        additionalProperties: false
      }
    }
  });


  tools.push({
    type: "function",
    function: {
      name: "retrieve_tool_result",
      description:
        "按引用检索之前溢出的工具输出。接受 tool_call_id、SHA 前缀或 handle id。" +
        "支持模式: summary（默认）、head、tail、lines（行范围）、query（子串搜索）。" +
        "无 ref 参数时列出所有可用溢出输出。",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: "Tool call id、SHA 前缀（sha:abc123）、handle id。省略时列出所有可用溢出输出。"
          },
          mode: {
            type: "string",
            enum: ["summary", "head", "tail", "lines", "query"],
            description: "检索模式。默认为 summary。"
          },
          lines: {
            type: "string",
            description: "当 mode=lines 时指定行范围，如 '100-200' 或 '100-'。当 mode=head/tail 时可指定数字行数。"
          },
          query: {
            type: "string",
            description: "当 mode=query 时的搜索子串（不区分大小写）。"
          },
          context: {
            type: "number",
            description: "当 mode=query 时每个匹配前后的上下文行数（默认 1，最大 5）。"
          },
          max_matches: {
            type: "number",
            description: "当 mode=query 时的最大匹配数（默认 20，最大 100）。"
          },
          max_bytes: {
            type: "number",
            description: "当 mode=summary 时的最大输出字节数（默认 8192，最大 131072）。"
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  });

  // Supervisor-Worker 委派：仅当 autoSwitch=on + model=Pro 时注册
  if (_options.supervisorMode) {
    tools.push({
      type: "function",
      function: {
        name: "spawn_code_executor",
        description:
          "将代码修改任务委派给 deepseek-v4-flash 子智能体执行。" +
          "子智能体拥有隔离的上下文（仅包含文件内容 + 修改指令），不影响主会话缓存。" +
          "使用时机：多行修改（>5行）、跨文件修改、需要重写的场景。" +
          "不使用时机：单行修正、变量重命名——这些直接用 edit_file。" +
          "子智能体默认开启思考模式（effort=high），迭代上限 8 次。" +
          "对机械替换类任务（改类型名、改函数签名），Supervisor 可传 enable_thinking=false 节省 token。",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "精确的修改指令。子智能体没有对话上下文——必须自包含。" +
                "写明要改什么、改成什么、为什么这样改。例如：'将 auth.ts 第10-50行的 login 函数从同步回调改为 async/await，支持 Promise 链式调用'。",
            },
            file_paths: {
              type: "array",
              items: { type: "string" },
              description:
                "要修改的目标文件的绝对路径列表。跨文件修改时一次传入所有相关文件，" +
                "子智能体会在同一个上下文中依次处理所有文件。单文件修改时传包含一个元素的数组。",
            },
            context: {
              type: "string",
              description:
                "关键上下文片段（如相关类型定义、调用方签名、import 路径）。" +
                "当 task 涉及外部类型/函数名时**必须**提供此字段，否则子智能体会因信息不足而失败。" +
                "不要粘贴完整文件——只提供修改所必需的类型和签名。",
            },
            require_confirmation: {
              type: "boolean",
              description:
                "可选：是否在 spawn 前要求用户确认。默认 false。" +
                "跨文件修改、删除代码超过 10 行、涉及关键模块时建议设为 true。",
            },
            allowed_tools: {
              type: "array",
              items: { type: "string", enum: ["read_file", "edit_file", "write_file", "grep"] },
              description:
                "可选：子智能体可使用的工具列表，默认仅 read_file + edit_file + write_file。" +
                "如需子智能体自行搜索定位代码，可追加 grep。",
            },
            enable_thinking: {
              type: "boolean",
              description:
                "可选：是否开启子智能体思考模式，默认 true。" +
                "对简单机械修改（改名、改类型签名）建议设为 false 以节省 token 和延迟。",
            },
          },
          required: ["task", "file_paths"],
          additionalProperties: false,
        },
      },
    });
  }

  // Explorer 子智能体工具：委派 Flash 探索代码库（只读，GitNexus 优先）
  if (_options.supervisorMode) {
    tools.push({
      type: "function",
      function: {
        name: "spawn_explorer",
        description:
          "将代码库探索任务委派给 Flash Explorer 子智能体。Explorer 拥有 GitNexus 知识图谱工具，" +
          "能导航式理解代码结构、追踪符号引用、分析变更影响。只返回精炼结论，不污染主会话。" +
          "使用时机：理解陌生代码、找到所有调用点、评估改动影响面、追踪错误传播路径。",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "精确的探索任务。如'找出所有调用 addMessage 的地方'。",
            },
            context: {
              type: "string",
              description: "可选：额外上下文。",
            },
            model: {
              type: "string",
              description: "可选：子智能体模型，默认 deepseek-v4-flash。",
            },
            max_iters: {
              type: "number",
              description: "可选：最大迭代次数，默认 20，上限 32。",
            },
            allowed_tools: {
              type: "array",
              items: { type: "string" },
              description: "可选：限制子智能体可用工具。",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    });
  }

  // GitNexus 知识图谱工具：提供代码库架构理解
  tools.push({
    type: "function",
    function: {
      name: "gitnexus_query",
      description:
        "在代码库知识图谱中执行混合搜索（BM25+语义+RRF融合）。" +
        "用于理解某个符号、函数、模块被谁调用、依赖了什么。" +
        "首次使用会自动索引代码库。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索查询，如 'auth validateUser' 或 'payment flow'"
          },
          max_chars: {
            type: "number",
            description: "返回的最大字符数，默认 8000。控制上下文窗口占用。"
          }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  });

  tools.push({
    type: "function",
    function: {
      name: "gitnexus_context",
      description:
        "获取单个符号的 360 度视图：所有引用者、被引用者、参与的进程。" +
        "用于理解某个函数/类的完整代码上下文。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "符号名称，如 'SessionManager'、'handleBashTool'"
          },
          max_chars: {
            type: "number",
            description: "返回的最大字符数，默认 6000。"
          }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  });

  tools.push({
    type: "function",
    function: {
      name: "gitnexus_impact",
      description:
        "变更前分析影响面：修改某个文件/符号会影响哪些进程和其他文件。" +
        "在代码审查或重构前使用，防止遗漏副作用。",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "要分析的目标文件路径或符号名称"
          },
          symbol: {
            type: "string",
            description: "可选：具体符号名称。不提供则分析文件级影响。"
          }
        },
        required: ["target"],
        additionalProperties: false
      }
    }
  });

  tools.push({
    type: "function",
    function: {
      name: "gitnexus_clusters",
      description:
        "从 MCP 资源读取代码库的功能聚类（Leiden 社区检测）及内聚度评分。" +
        "用于快速理解陌生代码库的分层结构。",
      parameters: {
        type: "object",
        properties: {
          cluster: {
            type: "string",
            description: "可选：指定聚类名称获取成员详情，省略则列出所有聚类。"
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  });

  tools.push({
    type: "function",
    function: {
      name: "gitnexus_processes",
      description:
        "列出或追踪代码库的执行流：函数调用链、事件传播路径。" +
        "调试或理解端到端业务逻辑时使用。",
      parameters: {
        type: "object",
        properties: {
          process: {
            type: "string",
            description: "可选：指定进程名称读取特定的进程追踪详情，省略则列出所有进程。"
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  });

  return tools;
}




