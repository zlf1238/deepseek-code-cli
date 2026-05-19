# DeepSeek Code CLI

在终端中为 deepseek-v4 模型进行 Vibe Coding。

## 运行

```sh
npm run build && node dist/cli.cjs
```

## 配置

创建 `~/.deepseek-code/settings.json`：

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

技能文件存放在：

- `~/.agents/skills/<name>/SKILL.md`（用户级）
- `./.deepseek-code/skills/<name>/SKILL.md`（项目级）

在 TUI 界面中按 `/` 打开技能选择器，或直接输入技能名称（例如 `/skill-writer`）。
