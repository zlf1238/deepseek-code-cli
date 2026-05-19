---
name: gitnexus-cli
description: "当用户需要运行 GitNexus CLI 命令时使用，如分析/索引仓库、检查状态、清理索引、生成 Wiki 或列出已索引仓库。示例：\"索引此仓库\"、\"重新分析代码库\"、\"生成 Wiki\""
---

# GitNexus CLI 命令

所有命令通过 `npx` 运行 —— 无需全局安装。

## 命令

### analyze — 构建或刷新索引

```bash
npx gitnexus analyze
```

在项目根目录运行。此命令会解析所有源文件，构建知识图谱，写入 `.gitnexus/`，并生成 CLAUDE.md / AGENTS.md 上下文文件。

| 标志               | 效果                                               |
| ------------------ | -------------------------------------------------- |
| `--force`          | 即使索引已更新也强制完全重建                         |
| `--embeddings`     | 启用语义搜索的嵌入生成（默认关闭）                    |
| `--drop-embeddings` | 重建时丢弃现有嵌入。默认情况下，不带 `--embeddings` 的 `analyze` 会保留嵌入。 |

**何时运行：** 首次进入项目、大规模代码变更后、或 `gitnexus://repo/{name}/context` 报告索引过时时。在 Claude Code 中，PostToolUse hook 在 `git commit` 和 `git merge` 后检测到过期并通知 agent 运行 `analyze`——hook 不会自动运行 analyze，以避免阻塞 agent 长达 120 秒并导致 KuzuDB 在超时时损坏。

### status — 检查索引新鲜度

```bash
npx gitnexus status
```

显示当前仓库是否有 GitNexus 索引、上次更新时间以及符号/关系数量。用于检查是否需要重新索引。

### clean — 删除索引

```bash
npx gitnexus clean
```

删除 `.gitnexus/` 目录并从全局注册表中注销该仓库。在索引损坏时重新索引前使用，或在从项目中移除 GitNexus 后使用。

| 标志      | 效果                             |
| --------- | -------------------------------- |
| `--force` | 跳过确认提示                      |
| `--all`   | 清理所有已索引的仓库，不仅限于当前 |

### wiki — 从图谱生成文档

```bash
npx gitnexus wiki
```

使用 LLM 从知识图谱生成仓库文档。需要 API 密钥（首次使用时保存到 `~/.gitnexus/config.json`）。

| 标志                  | 效果                                    |
| --------------------- | --------------------------------------- |
| `--force`             | 强制完全重新生成                          |
| `--model <model>`     | LLM 模型（默认：minimax/minimax-m2.5）    |
| `--base-url <url>`    | LLM API 基础 URL                         |
| `--api-key <key>`     | LLM API 密钥                             |
| `--concurrency <n>`   | 并行 LLM 调用数（默认：3）                |
| `--gist`              | 将 Wiki 发布为公开的 GitHub Gist          |

### list — 显示所有已索引的仓库

```bash
npx gitnexus list
```

列出 `~/.gitnexus/registry.json` 中注册的所有仓库。MCP 的 `list_repos` 工具提供相同的信息。

## 索引之后

1. **读取 `gitnexus://repo/{name}/context`** 验证索引已加载
2. 根据任务使用其他 GitNexus 技能（`exploring`、`debugging`、`impact-analysis`、`refactoring`）

## 故障排除

- **"Not inside a git repository"**：在 git 仓库目录内运行
- **重新分析后索引仍然过期**：重启 Claude Code 以重新加载 MCP 服务器
- **嵌入生成慢**：省略 `--embeddings`（默认关闭）或设置 `OPENAI_API_KEY` 以获得更快的基于 API 的嵌入
