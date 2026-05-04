# DeepSeek Code CLI

Vibe coding for the deepseek-v4 model, in your terminal.

## 运行

```sh
npm run build && node dist/cli.cjs
```

## 配置

Create `~/.deepseek-code/settings.json`:

```json
{
  "env": {
    "MODEL": "deepseek-v4-pro",
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

## 技能

Skills live in:

- `~/.agents/skills/<name>/SKILL.md` (user-level)
- `./.deepseek-code/skills/<name>/SKILL.md` (project-level)

Inside the TUI press `/` to open the skill picker, or type the skill name directly (e.g. `/skill-writer`).
