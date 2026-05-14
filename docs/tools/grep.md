## Grep

使用文本或正则表达式搜索文件内容。返回文件路径、行号和上下文行。

使用方法：
- pattern 是一个要在文件内容中搜索的文本字符串或基本正则表达式。
- 结果包括匹配行及其文件路径、行号和上下文行（之前/之后）。
- 来自不同文件的匹配结果由 `--` 分隔。
- 使用 `include` 按文件扩展名过滤（例如 `"*.ts"`、`"*.tsx,*.js"`）。
- 使用 `context` 控制每个匹配前后显示的上下文行数（默认为 2）。
- 使用 `ignoreCase` 进行不区分大小写的匹配。
- 常见目录（node_modules、.git、dist、build、.next、.nuxt）会自动排除。
- 进行代码搜索时，始终优先使用 grep 而不是 bash 的 grep/rg —— 它更安全、更快，且遵循项目边界。
- 使用 grep 定位符号、函数或模式，然后再使用带有 offset/limit 的 read 进行精确读取。
- 将 grep 与 read 结合使用，实现高效的"先搜索后读取"工作流。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "要在文件内容中搜索的文本或正则表达式模式。",
      "type": "string"
    },
    "path": {
      "description": "要搜索的目录或文件路径。默认为项目根目录。",
      "type": "string"
    },
    "include": {
      "description": "文件模式过滤器（例如 "*.ts"、"*.tsx,*.js"）。以逗号分隔。",
      "type": "string"
    },
    "context": {
      "description": "每个匹配前后显示的上下文行数。默认为 2。",
      "type": "number",
      "default": 2
    },
    "ignoreCase": {
      "description": "匹配时是否忽略大小写。默认为 false。",
      "type": "boolean",
      "default": false
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```
