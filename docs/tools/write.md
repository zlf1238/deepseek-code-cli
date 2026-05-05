## Write

将文件写入本地文件系统。

使用方法：
- 如果提供的路径已存在文件，此工具将覆盖该文件。
- 如果是现有文件，**必须**先读取完整文件。仅部分读取不足以覆盖现有文件。
- `content` 必须是一个字符串。如果要写入 JSON，在调用此工具之前将完整文档序列化为文本。
- 优先使用 `Edit` 来更新现有文件。对于新文件或有意的完整文件重写，使用 `Write`。
- **始终**优先编辑代码库中的现有文件。除非明确要求，**绝不**创建新文件。
- **绝不**主动创建文档文件（*.md）或 README 文件。只有在用户明确要求时才创建文档文件。
- **绝不**主动创建一次性测试脚本。只有在用户明确要求时才创建一次性测试脚本文件。
- 只有在用户明确要求时才使用表情符号。除非被要求，否则避免在文件中写入表情符号。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "file_path": {
      "description": "要写入的文件的绝对路径（必须是绝对路径，不是相对路径）",
      "type": "string"
    },
    "content": {
      "description": "完整的文件内容，作为一个字符串",
      "type": "string"
    }
  },
  "required": [
    "file_path",
    "content"
  ],
  "additionalProperties": false
}
```
