## [Unreleased]

### Added

- **多模型切换 `/model`** — 新增 `/model` 斜杠命令 + 下拉选择框，支持：
  - `settings.json` 新增 `"models"` 字段指定每个模型的 `apiKey` / `baseURL`（跨厂商）
  - 下拉框显示厂商标签（DeepSeek / Zhipu）和当前活跃标记
  - 切换后自动持久化到 `settings.json`
  - 已配置：deepseek-v4-pro、deepseek-v4-flash、glm-4-plus、glm-5.1
- **状态行显示当前模型** — 状态行末尾添加模型信息，显示模型名称和厂商标签：
  - 空闲时：`enter send · ... · model: glm-4-plus (Zhipu)`
  - 加载时：`Thinking... · model: deepseek-v4-pro (DeepSeek)`
  - 状态消息时不显示（临时提示优先）

- **grep 工具** — 新增代码内容搜索工具

### Fixed

- **斜杠菜单 `/new` 历史未清除** — 修复方向键选择 `/new` 时 skills 异步加载导致 menuIndex 错位的 bug

- **glob 工具** — 新增文件名通配符搜索工具，封装 GNU find，支持：
  - `pattern` — 通配符（如 `"**/*.ts"`、`"*.json"`）
  - `path` — 搜索目录（默认项目根目录，禁止逃逸到项目外）
  - `"*.ext"`（不含 `**`）自动限制为当前目录
  - `"**/*.ext"` 递归搜索整个项目
  - 自动排除常见目录

### Changed

- **grep/glob 注册** — `src/tools/executor.ts` 中注册两个新工具处理器
- **工具定义** — `src/prompt.ts` 中添加 JSON Schema 定义，注入 system prompt
- **上下文容量显示** — 状态行从 `tokens: 80000` 改为 `tokens: 80k/512k (15%)`，显示当前使用量和百分比
- **压缩通知** — 上下文压缩时显示 visible 提示，包含压缩前后 token 数对比

### Files

| 操作 | 文件 |
|------|------|
| 新增 | `src/tools/grep-handler.ts` |
| 新增 | `src/tools/glob-handler.ts` |
| 新增 | `docs/tools/grep.md` |
| 新增 | `docs/tools/glob.md` |
| 修改 | `src/tools/executor.ts` |
| 修改 | `src/prompt.ts` |
| 修改 | `src/session.ts` |
| 修改 | `src/ui/App.tsx` |

### Migrated

- `context-onboarding`、`decision-docs-workflow`、`session-continuity`、`systematic-debugging` 四个技能从项目级（`./.deepcode/skills/`）迁移到用户级（`~/.agents/skills/`），现在所有项目通用
