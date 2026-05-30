# DeepSeek Code CLI

在终端中使用 DeepSeek-V4 模型进行 AI 辅助编程（Vibe Coding）。

## 前置依赖

| 工具 | 用途 | 安装 |
|------|------|------|
| **ripgrep** (`rg`) | 代码全文搜索（毫秒级） | `apt install ripgrep` / `brew install ripgrep` / `winget install BurntSushi.ripgrep` |
| **GitNexus** | 代码知识图谱（符号索引、影响面分析） | `npm install -g gitnexus` |
| **Node.js** ≥ 22 | 运行环境 | [nodejs.org](https://nodejs.org) |

> 如果 ripgrep 未安装，搜索命令会返回安装提示。GitNexus 按需使用，不安装不影响基本功能。

## 安装

```sh
cd deepseek-code-cli
npm install
npm run build
```

## 运行

```sh
node dist/cli.cjs
```

首次运行时会在 `~/.deepseek-code/` 创建配置目录。

## 配置

编辑 `~/.deepseek-code/settings.json`：

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

### 完整配置项

```jsonc
{
  "env": {
    "MODEL": "deepseek-v4-pro",       // 默认模型
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "mode": "pro",                       // pro | flash | auto（模型自动切换）
  "thinkingEnabled": true,             // 开启思考模式
  "reasoningEffort": "max",            // high | max
  "verboseMode": false,                // 详细模式：显示完整思考过程
  "autoSwitch": {
    "enabled": true,                   // 价格感知模型自动切换
    "maxPaybackRounds": 8
  },
  "pricing": {
    "inputPricePerMillion": 0.55,      // 自定义输入价格（元/百万token）
    "outputPricePerMillion": 2.19
  },
  "gitnexus": {
    "enabled": true,                   // GitNexus 知识图谱集成
    "autoIndex": true,                 // 会话启动时自动索引
    "maxIndexAgeMinutes": 30           // 索引过期时间
  }
}
```

## 项目级规则：AGENTS.md

在项目根目录创建 `AGENTS.md`，写入项目特定的规则。CLI 会自动将其与全局规则（`~/.deepseek-code/AGENTS.md`）合并注入 system prompt。

```markdown
## 项目规则

- 使用 TypeScript 严格模式
- API 返回值统一用 `{ code, data, message }` 格式
```

## 核心工具

### 搜索

| 工具 | 说明 | 示例 |
|------|------|------|
| `grep` | 代码内容搜索（底层 ripgrep，自动 `.gitignore`） | 搜函数名、API 路径、字符串 |
| `glob` | 文件名搜索（底层 rg --files） | 查找 `*.vue`、`**/*.test.ts` |
| `gitnexus_query` | 知识图谱语义搜索 | 搜概念、执行流（需索引） |
| `gitnexus_context` | 符号 360° 视图 | 查看函数调用者/被调用者 |

**搜索策略**：有索引的项目 → `gitnexus_query`；无索引 → `grep` 两步法：

```
第一步：grep(pattern, { outputMode: "files_with_matches" })  → 毫秒级定位文件
第二步：grep(pattern, { path: "命中的文件", context: 5 })     → 精确读取上下文
```

### 文件编辑

| 工具 | 场景 |
|------|------|
| `edit` | 单文件、单处修改（支持 Unicode 模糊匹配：智能引号、全角→半角） |
| `multi_edit` | 单文件多处 / 跨文件修改，全内存操作，一次读写 |

### 文件读取

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容，支持 `offset`/`limit` |
| `handle_read` | 按 snippet_id 读取缓存切片（跨轮次零 I/O） |
| `directory_tree` | 目录树形列表，支持 `maxDepth` |
| `get_file_info` | 文件元信息（大小、行数、修改时间） |

### 命令执行

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令（Linux/macOS 用 bash，Windows 用 cmd.exe） |

### GitNexus 安全分析

| 工具 | 说明 |
|------|------|
| `gitnexus_impact` | 修改前分析影响面（谁依赖此符号？会坏什么？） |
| `gitnexus_detect_changes` | 提交前检测变更影响范围 |
| `gitnexus_rename` | 安全重命名（自动更新所有引用） |

## Windows 使用

- bash 工具在 Windows 上自动使用 `cmd.exe`（通过 `%COMSPEC%`）
- 如果安装了 Git Bash 且设置了 `SHELL` 环境变量，优先使用 Git Bash
- ripgrep 通过 winget 安装：`winget install BurntSushi.ripgrep.MSVC`

## 技能系统

技能文件提供专项领域知识：

- `~/.agents/skills/<name>/SKILL.md` — 用户级
- `./.deepseek-code/skills/<name>/SKILL.md` — 项目级

在 TUI 中按 `/` 打开技能选择器。

## TUI 快捷键

| 按键 | 功能 |
|------|------|
| `/` | 技能选择器 |
| `Ctrl+C` | 中断当前操作 |
| `Alt+数字` | 展开/折叠思考过程 |
| 输入 `exit` | 退出 |

## 项目结构

```
src/
├── tools/           # 工具处理器（grep, edit, bash, gitnexus 等）
├── prompt.ts        # system prompt 构建
├── session.ts       # 会话管理、API 调用
├── settings.ts      # 配置解析
├── repair/          # 输出修复（截断、JSON 修复）
└── ui/              # TUI 组件（Ink 渲染）
```
