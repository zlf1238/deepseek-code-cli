## Edit

在文件中执行范围字符串替换。

使用方法：
- 在编辑之前，你必须在会话中至少使用一次 `Read` 工具。如果你在未读取文件的情况下尝试编辑，此工具会报错。
- 如果之前的 Read 只覆盖了文件的一部分，使用返回的 `snippet_id` 来限定编辑范围，或者在没有 snippet 的情况下先读取完整文件再编辑。
- 从 Read 工具输出中编辑文本时，确保保留行号前缀**之后**的确切缩进（制表符/空格）。行号前缀格式为：空格 + 行号 + 制表符。制表符之后的所有内容才是要匹配的实际文件内容。永远不要在 old_string 或 new_string 中包含行号前缀的任何部分。
- 当你想要将替换限制在已知范围内时，优先传递之前 Read 响应中的 `snippet_id`。
- **始终**优先编辑代码库中的现有文件。除非明确要求，**绝不**创建新文件。
- 只有在用户明确要求时才使用表情符号。除非被要求，否则避免在文件中添加表情符号。
- 如果 `old_string` 不唯一，此工具会返回候选匹配项及其行范围、预览和 snippet id，你可以在后续编辑中重复使用。
- 如果找不到 `old_string`，此工具会在元数据中返回最接近的可能匹配项，包括预览。如果唯一的区别是转义方式且存在唯一的宽松转义匹配，此工具可能会使用配置的模型在重试前修正 `old_string` 和 `new_string`。
- `replace_all` 有安全检查。对于范围较大或短片段的替换，提供 `expected_occurrences` 以便工具在编辑前验证确切的匹配次数。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "要修改的文件的绝对路径（必须是绝对路径，不是相对路径）。当提供了 snippet_id 时可省略。",
      "type": "string"
    },
    "snippet_id": {
      "description": "由 Read 或先前的 Edit 错误响应返回的 Snippet id。将搜索范围限制在该 snippet 内。",
      "type": "string"
    },
    "old_string": {
      "description": "要在文件或 snippet 范围内替换的文本",
      "type": "string"
    },
    "new_string": {
      "description": "替换后的文本（必须与 old_string 不同）",
      "type": "string"
    },
    "replace_all": {
      "description": "替换所有出现的 old_string（默认为 false）",
      "default": false,
      "type": "boolean"
    },
    "expected_occurrences": {
      "description": "预期的匹配次数。对 replace_all 来说是一个有用的安全保障。",
      "type": "number"
    }
  },
  "required": [
    "old_string",
    "new_string"
  ],
  "additionalProperties": false
}
```

**语言要求：** 此工具的所有输入输出参数说明及使用指南均使用中文（技术术语可保留原文）。
