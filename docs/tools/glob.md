## Glob

查找匹配 glob 模式的文件。返回排序后的文件路径列表。

使用方法：
- pattern 必须是类似 `"**/*.ts"`、`"*.json"` 或 `"src/**/*.test.tsx"` 的文件名 glob 模式。
- 使用纯 `"*.ext"`（不带 `**`）仅限当前目录。
- 使用 `"**/*.ext"` 递归搜索整个项目。
- `path` 参数覆盖搜索目录（默认为项目根目录）。
- 常见目录（node_modules、.git、dist、build、.next、.nuxt）会自动排除。
- 在不知道确切文件路径时，执行 read 之前使用 glob。
- 当你需要先查找匹配模式的文件再搜索它们的内容时，将 glob 与 grep 结合使用。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "用于匹配文件名的 glob 模式（例如 "**/*.ts"、"*.json"、"src/**/*.test.ts"）。",
      "type": "string"
    },
    "path": {
      "description": "要搜索的目录。默认为项目根目录。",
      "type": "string"
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```
