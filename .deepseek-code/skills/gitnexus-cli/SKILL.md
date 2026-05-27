---
name: gitnexus-cli
description: "当用户需要运行 GitNexus CLI 命令时使用，如分析/索引仓库、检查状态、清理索引、生成 wiki 或列出已索引的仓库。示例：\"索引此仓库\"、\"重新分析代码库\"、\"生成 wiki\""
---

# GitNexus CLI 命令

所有命令通过 `npx` 运行——无需全局安装。

## 命令

### analyze — 构建或刷新索引

```bash
npx gitnexus analyze
```

在项目根目录运行。此命令解析所有源文件、构建知识图谱、写入 `.gitnexus/` 目录，并生成 CLAUDE.md / AGENTS.md 上下文文件。

| 标志             | 作用                                                     |
| --------------- | -------------------------------------------------------- |
| `--force`       | 即使已是最新也强制完全重建索引                               |
| `--embeddings`  | 启用嵌入向量生成以支持语义搜索（默认关闭）                     |
| `--drop-embeddings` | 重建时丢弃现有嵌入向量。默认情况下，不带 `--embeddings` 的 `analyze` 会保留它们。 |

**何时运行：** 首次进入项目时、重大代码变更后、或 `gitnexus://repo/{name}/context` 报告索引过期时。在 Claude Code 中，PostToolUse 钩子在 `git commit` 和 `git merge` 后检测过期状态并通知智能体运行 `analyze`——钩子本身不执行 analyze，以避免阻塞智能体长达 120 秒并在超时时导致 KuzuDB 损坏。

### status — 检查索引新鲜度

```bash
npx gitnexus status
```

显示当前仓库是否有 GitNexus 索引、最后更新时间以及符号/关系计数。用于检查是否需要重建索引。

### clean — 删除索引

```bash
npx gitnexus clean
```

删除 `.gitnexus/` 目录并从全局注册表中注销该仓库。在索引损坏时重建前使用，或从项目中移除 GitNexus 时使用。

| 标志      | 作用                                       |
| -------- | ------------------------------------------ |
| `--force` | 跳过确认提示                               |
| `--all`   | 清理所有已索引的仓库，不仅限于当前仓库       |

### wiki — 从图谱生成文档

```bash
npx gitnexus wiki
```

使用 LLM 从知识图谱生成仓库文档。需要 API 密钥（首次使用时保存到 `~/.gitnexus/config.json`）。

| 标志                | 作用                                      |
| ------------------- | ----------------------------------------- |
| `--force`           | 强制完全重新生成                           |
| `--model <model>`   | LLM 模型（默认：minimax/minimax-m2.5）     |
| `--base-url <url>`  | LLM API 基础 URL                          |
| `--api-key <key>`   | LLM API 密钥                              |
| `--concurrency <n>` | 并行 LLM 调用数（默认：3）                 |
| `--gist`            | 将 wiki 发布为公开 GitHub Gist            |

### list — 显示所有已索引仓库

```bash
npx gitnexus list
```

列出所有在 `~/.gitnexus/registry.json` 中注册的仓库。MCP 的 `list_repos` 工具提供相同信息。

## 索引之后

1. **读取 `gitnexus://repo/{name}/context`** 验证索引已加载
2. 根据任务使用其他 GitNexus 技能（`exploring`、`debugging`、`impact-analysis`、`refactoring`）

## 故障排查

- **"Not inside a git repository"**：从 git 仓库内的目录运行
- **重新分析后索引仍显示过期**：重启 Claude Code 以重新加载 MCP 服务器
- **嵌入向量生成慢**：省略 `--embeddings`（默认关闭）或设置 `OPENAI_API_KEY` 以使用更快的基于 API 的嵌入
