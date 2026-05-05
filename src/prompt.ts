import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SessionMessage } from "./session";

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

重要提示：除非你确信 URL 有助于用户编程，否则**绝不**为用户生成或猜测 URL。你可以使用用户消息或本地文件中提供的 URL。`;

/** Flash 模型的系统提示词 — 精简、聚焦文件操作，不进行复杂分析。 */
const SYSTEM_PROMPT_FLASH = `你是一个专注于文件操作的助手。你的唯一任务是快速准确地执行用户的文件操作请求。

核心原则：
- 用户要求读文件 → 直接用 read 工具
- 用户要求编辑文件 → 直接用 edit 工具
- 用户要求新建文件 → 直接用 write 工具
- 用户要求搜索文件/内容 → 直接用 glob/grep 工具

不需要分析需求背景，不需要规划多步方案，不需要问用户确认细节。
直接执行，做完即止。`;

type PromptToolOptions = {
  webSearchEnabled?: boolean;
  /** 为 flash 模型时返回精简版提示词和工具 */
  model?: string;
  /** true = 代码内自动切换（用精简版），false/省略 = 手动指定（用完整版） */
  flashAutoSwitch?: boolean;
};

const FLASH_TOOL_NAMES = new Set(["read", "write", "edit", "glob", "grep"]);

function readToolDocs(extensionRoot: string, options: PromptToolOptions = {}): string {
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

  // Flash 模型在自动切时只保留文件操作工具的文档
  if (options.model === "deepseek-v4-flash" && options.flashAutoSwitch) {
    return docs
      .filter((doc) => {
        const nameMatch = doc.match(/^##\s+(\w+)/m);
        return nameMatch && FLASH_TOOL_NAMES.has(nameMatch[1].toLowerCase());
      })
      .join("\n\n");
  }

  return docs.join("\n\n");
}

export function getSystemPrompt(projectRoot: string, options: PromptToolOptions = {}): string {
  // flashAutoSwitch=true 时用精简版提示词（自动切换优化），否则用完整版
  const isFlashAutoSwitch = options.model === "deepseek-v4-flash" && options.flashAutoSwitch;
  const systemBase = isFlashAutoSwitch ? SYSTEM_PROMPT_FLASH : SYSTEM_PROMPT_BASE;
  const toolDocs = readToolDocs(getExtensionRoot(), options);
  const basePrompt = toolDocs
    ? `${systemBase}\n\n# 可用工具\n\n${toolDocs}`
    : systemBase;
  return `${basePrompt}\n\n${getRuntimeContext(projectRoot)}`;
}

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

export function getTools(options: PromptToolOptions = {}): ToolDefinition[] {
  const isFlash = options.model === "deepseek-v4-flash";

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

  // Flash 模型在自动切换时只暴露文件操作工具
  if (isFlash && options.flashAutoSwitch) {
    return tools.filter((tool) => FLASH_TOOL_NAMES.has(tool.function.name));
  }

  return tools;
}

/**
 * 当代码内自动从 pro 切换到 flash 时，注入此系统消息告知 AI 角色变更。
 * 此时 tools 已切换到精简版（仅 5 个文件工具），thinking 已关闭。
 */
export function getFlashAutoSwitchMessage(): string {
  return `[系统已自动切换模型]

当前模型已切换为 deepseek-v4-flash（快速模式）。
可用工具：read、write、edit、glob、grep。
不启用深度思考。不需要分析规划，直接执行用户请求。`;
}
