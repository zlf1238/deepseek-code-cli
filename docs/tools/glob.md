## Glob

Find files matching a glob pattern. Returns a sorted list of matching file paths.

Usage:
- The pattern must be a file name glob like `"**/*.ts"`, `"*.json"`, or `"src/**/*.test.tsx"`.
- Use plain `"*.ext"` (without `**`) to limit to the current directory only.
- Use `"**/*.ext"` to recursively search the entire project.
- The `path` parameter overrides the search directory (defaults to project root).
- Common directories (node_modules, .git, dist, build, .next, .nuxt) are automatically excluded.
- Use glob before performing a read when you don't know the exact file path.
- Use glob with grep when you need to find files matching a pattern and then search inside them.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "description": "Glob pattern to match file names against (e.g., \"**/*.ts\", \"*.json\", \"src/**/*.test.ts\").",
      "type": "string"
    },
    "path": {
      "description": "Directory to search in. Defaults to the project root.",
      "type": "string"
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```
