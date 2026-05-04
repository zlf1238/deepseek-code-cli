## Grep

Search file contents using text or regex. Returns file paths, line numbers, and context lines.

Usage:
- The pattern is a text string or basic regex to search for in file contents.
- Results include matching lines with file path, line number, and context lines (before/after).
- Matches from different files are separated by `--`.
- Use `include` to filter by file extension (e.g., `"*.ts"`, `"*.tsx,*.js"`).
- Use `context` to control how many lines of context are shown around each match (default 2).
- Use `ignoreCase` for case-insensitive matching.
- Common directories (node_modules, .git, dist, build, .next, .nuxt) are automatically excluded.
- Always prefer grep over bash grep/rg for code search — it's safer, faster, and respects project boundaries.
- Use grep to locate symbols, functions, or patterns before doing a precise read with offset/limit.
- Combine grep with read for an efficient "search then read" workflow.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "Text or regex pattern to search for in file contents.",
      "type": "string"
    },
    "path": {
      "description": "Directory or file path to search in. Defaults to the project root.",
      "type": "string"
    },
    "include": {
      "description": "File pattern filter (e.g., \"*.ts\", \"*.tsx,*.js\"). Comma-separated.",
      "type": "string"
    },
    "context": {
      "description": "Number of context lines to show before and after each match. Defaults to 2.",
      "type": "number",
      "default": 2
    },
    "ignoreCase": {
      "description": "Whether to ignore case when matching. Defaults to false.",
      "type": "boolean",
      "default": false
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```
