---
name: code-review
description: 对 deepseek-code-cli 项目进行代码审查时的检查清单和重点关注领域。确保代码符合项目约定、类型安全、性能合理且测试充分。
---

# Code Review — deepseek-code-cli

## 审查前准备

1. 用 `grep` 或 `glob` 定位所有受影响的文件
2. 读取变更文件的全貌（至少读到关键函数和类型定义）
3. 读取相关的测试文件，确认测试覆盖范围

---

## 检查清单

### 1. 类型安全（最高优先级）

- [ ] **禁止 `any`** — 项目中 `strict: true`，必须用 `unknown` + 类型守卫
- [ ] 类型守卫模式是否与项目一致（参考 `isUsageRecord()` 模式）
- [ ] 函数签名是否清晰（参数和返回值类型明确）
- [ ] 类型导出使用 `export type` 而非 `export`
- [ ] 外部 API 返回值的类型是否正确处理（`unknown` 无法直接使用）

### 2. 错误处理

- [ ] 工具 handler 的返回值格式是否为 `{ ok: boolean, name: string, output?: string, error?: string, metadata?: object }`
- [ ] 异步操作是否有 try-catch
- [ ] AbortError 是否被正确传播（`isAbortLikeError()` 检查后 re-throw）
- [ ] 工具执行失败是否返回了明确的错误信息（不仅是抛异常）
- [ ] 网络/IO 操作是否有超时或中断处理

### 3. React Ink 组件规范

- [ ] 使用 React 17 + Ink 3 兼容的 API（无 React 18 新 hooks）
- [ ] 组件是函数组件，props 有类型定义
- [ ] 避免不必要的 re-render（Ink 渲染昂贵）
- [ ] 键盘事件处理使用 `useInput` hook
- [ ] 没有在组件中直接做 IO/网络操作

### 4. 会话消息模型

- [ ] 新增消息类型是否遵循 `SessionMessage` 接口
- [ ] role 只能是 `"system" | "user" | "assistant" | "tool"`
- [ ] Meta 信息是否正确设置（`asThinking`、`isStepIndicator` 等）
- [ ] 工具结果格式：`JSON.stringify({ ok, name, output, error, metadata })`

### 5. 测试覆盖

- [ ] 新增的纯函数是否有单元测试
- [ ] 测试文件放在 `src/tests/` 下，命名为 `*.test.ts`
- [ ] 测试使用 `tsx --test` 运行
- [ ] 测试覆盖了正常路径和异常路径
- [ ] 没有跳过测试（`skip`/`todo` 需合理说明）

### 6. 性能考量

- [ ] 避免在热路径上做同步文件 IO
- [ ] LLM 流式响应处理是否高效（参考 `createChatCompletionStream` 模式）
- [ ] 会话消息数量是否有限制（`MAX_SESSION_ENTRIES = 50`）
- [ ] 大的 JSON 解析是否有 try-catch
- [ ] 工具执行结果的 content 是否可能过大（超过 2000 字符截断）

### 7. 构建与兼容性

- [ ] 没有修改 `package.json` 的核心依赖版本
- [ ] 新增依赖是否必要（优先用 Node 内置 API）
- [ ] 代码是否兼容 Node 18+（`engines` 要求）
- [ ] 构建命令 `npm run build` 能通过（typecheck + bundle）
- [ ] 没有破坏 `tsconfig.json` 的 `strict: true`

### 8. 模型兼容性

- [ ] 如果新增了工具，是否考虑了 flash 模型的兼容性
- [ ] flash 模型不支持的工具有无降级行为
- [ ] `FLASH_TOOL_NAMES` 是否需要更新

### 9. 安全性

- [ ] bash 命令执行是否经过合理验证
- [ ] 文件路径操作是否防注入（路径遍历）
- [ ] 用户输入显示是否做了 XSS/注入防护（Ink 是终端渲染，但要注意 escape）
- [ ] API key 等敏感信息没有硬编码或泄露

### 10. 代码风格

- [ ] 项目使用 CommonJS 模块（`require`/`module.exports`）还是 ESM？→ **CommonJS**
- [ ] 缩进一致（项目使用 2 空格）
- [ ] 命名风格一致（camelCase 变量/函数，PascalCase 类型/组件）
- [ ] 未使用的 import 和变量已清理
- [ ] console.log / debug 代码已移除

---

## 常见问题模式

```
// ❌ 错误：使用 any
function process(data: any) { ... }

// ✅ 正确：使用 unknown + 类型守卫
function process(data: unknown) {
  if (isUsageRecord(data)) { ... }
}
```

```
// ❌ 错误：工具结果格式不规范
return "成功";

// ✅ 正确：使用标准格式
return JSON.stringify({ ok: true, name: "my-tool", output: "成功" });
```

```
// ❌ 错误：没有处理中断信号
const result = await api.call();
return result;

// ✅ 正确：传播中断
try {
  const result = await api.call();
  return result;
} catch (error) {
  if (this.isAbortLikeError(error)) throw error;
  return { ok: false, name: "my-tool", error: String(error) };
}
```

---

## 审查输出格式

审查完成后，按以下格式输出结论：

```
## 审查结论
- **文件数**: N
- **严重问题**: N（必须修复）
- **建议**: N（可选的改进）
- **测试**: 通过/需补充/不存在
- **总体评估**: 通过/有条件通过/不通过
```
