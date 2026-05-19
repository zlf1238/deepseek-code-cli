## Bash

在当前 bash 会话中执行指定的命令。工作目录会在多次命令之间保持；shell 状态（其它一切）不会持久保存。Shell 环境从用户的配置文件（bash 或 zsh）初始化。

重要提示：此工具仅用于终端操作，如 git、npm、docker 等。**不要**将它用于文件操作（读取、写入、编辑、搜索、查找文件）——请改用专门的工具。

重要提示：在使用通用 shell 管道之前，优先选择专用的 CLI 工具，当它们能让你更准确、更安全、更快速或更易于理解时：
- 当你需要进行语法感知的代码搜索或结构性重写时，使用 `ast-grep`；优先于对代码使用纯文本匹配。
- 当你需要在工作区中通过文本或正则表达式搜索文件内容时，使用 `ripgrep`（`rg`）；优先于较慢的工具如 `grep`。
- 当你需要检查、过滤或转换 JSON 输出时，使用 `jq`；优先于使用 `sed`、`awk` 或 Python 单行代码的临时解析。

在执命令之前，请遵循以下步骤：

1. 目录检查：
   - 如果命令会创建新的目录或文件，先使用 `ls` 确认父目录存在且位置正确
   - 例如，在运行 `"mkdir foo/bar"` 之前，先使用 `ls foo` 检查 "foo" 是否存在且是否是预期的父目录

2. 命令执行：
   - 始终用双引号括起包含空格的路径（例如：cd "path with spaces/file.txt"）
   - 正确引用的示例：
     - cd "/Users/name/My Documents"（正确）
     - cd /Users/name/My Documents（错误 — 会失败）
     - python "/path/with spaces/script.py"（正确）
     - python /path/with spaces/script.py（错误 — 会失败）
   - 确保正确引用后，再执行命令。
   - 捕获命令的输出。

使用说明：
  - command 参数是必需的。
  - 为命令编写清晰、简洁的描述非常有帮助。对于简单命令，保持简短（5-10 个字）。对于复杂命令（管道命令、晦涩的标记或任何一眼看不懂的命令），添加足够的上下文来澄清其作用。
  - 如果输出超过 30000 个字符，在返回给你之前会被截断。
  - 始终优先使用这些工具的专用工具：
    - 读取文件：使用 Read（不要用 cat/head/tail）
    - 编辑文件：使用 Edit（不要用 sed/awk）
    - 写入文件：使用 Write（不要用 echo >/cat <<EOF）
    - 通信：直接输出文本（不要用 echo/printf）
  - 当发出多个命令时：
    - 如果命令之间独立且可以并行运行，在单条消息中调用多个 Bash 工具。例如，如果需要运行 `git status` 和 `git diff`，在一条消息中并行发送两个 Bash 工具调用。
    - 如果命令之间有依赖关系且必须按顺序运行，使用单个 Bash 调用并用 '&&' 连接它们（例如：`git add . && git commit -m "message" && git push`）。例如，如果某个操作必须在另一个操作开始之前完成（如 mkdir 在 cp 之前、Write 在 git 操作的 Bash 之前、或 git add 在 git commit 之前），则按顺序运行这些操作。
    - 仅当你需要按顺序运行命令但不在意前面的命令是否失败时，使用 ';'
    - **不要**使用换行符来分隔命令（换行符在带引号的字符串中是可以的）
  - 尝试通过使用绝对路径并避免使用 `cd` 来在整个会话中保持当前工作目录。如果用户明确要求，你可以使用 `cd`。
    <good-example>
    pytest /foo/bar/tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "command": {
      "description": "要执行的命令",
      "type": "string"
    },
    "description": {
      "description": "用主动语态清晰、简洁地描述此命令的作用。不要在描述中使用像"复杂"或"风险"这样的词——只要描述它做什么。\n\n对于简单命令（git、npm、标准 CLI 工具），保持简短（5-10 个字）：\n- ls → "列出当前目录中的文件"\n- git status → "显示工作树状态"\n- npm install → "安装包依赖"\n\n对于较难一眼看懂的复杂命令（管道命令、晦涩的标记等），添加足够的上下文来澄清其作用：\n- find . -name "*.tmp" -exec rm {} \\; → "递归查找并删除所有 .tmp 文件"\n- git reset --hard origin/main → "丢弃所有本地更改并匹配远程 main 分支"\n- curl -s url | jq '.data[]' → "从 URL 获取 JSON 并提取 data 数组元素"",
      "type": "string"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false
}
```

**语言要求：** 此工具的所有输入输出参数说明及使用指南均使用中文。工具的 description 参数必须用中文编写（技术术语可保留原文）。
