---
name: refactor
description: 对 deepseek-code-cli 进行代码重构时的指导原则和策略。聚焦于在不改变外部行为的前提下改善代码结构、可维护性和性能。
---

# Refactoring — deepseek-code-cli

## 核心原则

> "重构不改变外部可观察的行为" — Martin Fowler

对于本项目而言，外部行为包括：
- **CLI 命令行接口**（参数、输出格式、退出码）
- **会话格式**（`sessions-index.json` 和 `*.jsonl` 文件结构）
- **配置格式**（`settings.json` 的键名和类型）
- **API 调用模式**（OpenAI SDK 交互方式）
- **UI 行为**（快捷键、渲染内容、布局结构）

---

## 重构前准备

### 1. 理解现状

- 用 `grep` 找到重构目标的所有引用处
- 读取引用处，理解调用约定和期望
- 读取相关的测试文件，了解当前行为的契约
- 寻找**没有测试覆盖**的代码 — 这些是重构的风险区域

### 2. 建立安全网

- 检查相关测试是否可通过：`npx tsx --test src/tests/xxx.test.ts`
- 如果测试不充分，**先写测试再重构**（或至少确认手工测试路径）
- 确保构建通过：`npm run build`

---

## 重构策略（按优先级排序）

### 策略 1：提取函数（安全度 ⭐⭐⭐⭐⭐）

适用场景：长函数、重复代码块、复杂的条件逻辑

```typescript
// 重构前：内联逻辑
async function activateSession(...) {
  // ... 50 行 ...
  if (session.activeTokens > compactPromptTokenThreshold) {
    // 压缩逻辑
  }
  // ... 更多行 ...
}

// 重构后：提取为私有方法
async function activateSession(...) {
  // ...
  await this.maybeCompactSession(sessionId, compactPromptTokenThreshold);
  // ...
}

private async maybeCompactSession(sessionId: string, threshold: number): Promise<void> {
  const session = this.getSession(sessionId);
  if (!session || session.activeTokens <= threshold) return;
  // 压缩逻辑
}
```

### 策略 2：重命名（安全度 ⭐⭐⭐⭐⭐）

适用场景：变量/函数/类型命名不清晰

```typescript
// 工具：先用 grep 找到所有引用，再用 edit 逐个替换
// ❌ 模糊命名
function proc(d: unknown) { ... }
// ✅ 清晰命名
function processUserPrompt(userPrompt: UserPromptContent) { ... }
```

### 策略 3：提取类型（安全度 ⭐⭐⭐⭐）

适用场景：内联类型定义、重复的类型签名

```typescript
// 重构前：内联重复类型
private async doSomething(options: { signal?: AbortSignal; sessionId?: string }) { ... }
private async doOther(options: { signal?: AbortSignal; sessionId?: string }) { ... }

// 重构后：提取共享类型
type SessionOptions = {
  signal?: AbortSignal;
  sessionId?: string;
};

private async doSomething(options: SessionOptions) { ... }
private async doOther(options: SessionOptions) { ... }
```

### 策略 4：简化条件逻辑（安全度 ⭐⭐⭐⭐）

适用场景：嵌套的 if-else、复杂的布尔表达式

```typescript
// 重构前
if (!signal?.aborted) {
  if (result != null && result.status === "ok") {
    return processResult(result);
  }
}

// 重构后：提前返回
if (signal?.aborted) return null;
if (result == null || result.status !== "ok") return null;
return processResult(result);
```

### 策略 5：统一错误处理模式（安全度 ⭐⭐⭐）

适用场景：不一致的错误处理风格

```typescript
// 统一为项目的标准模式：
function myHandler() {
  try {
    const result = riskyOperation();
    return JSON.stringify({ ok: true, name: "my-tool", output: result });
  } catch (error) {
    if (isAbortLikeError(error)) throw error;
    return JSON.stringify({ ok: false, name: "my-tool", error: String(error) });
  }
}
```

---

## 本项目中的重构热点区域

### 1. session.ts（最大文件，2000+ 行）

- `SessionManager` 类承担了过多职责（会话管理 + LLM 交互 + 消息持久化 + 工具调度）
- 可以考虑将 `createChatCompletionStream` 提取到独立模块
- 将消息构建方法（`buildUserMessage`、`buildAssistantMessage` 等）提取到独立文件

### 2. prompt.ts（系统提示词和工具定义）

- 工具定义（JSON Schema）和提示词拼接逻辑可以分离
- `getTools()` 函数已较长，新增工具时可以考虑按工具拆分

### 3. UI 组件（Ink 渲染）

- 检查是否有不必要的 re-render（使用 `React.memo`）
- 长列表渲染是否使用了虚拟化

---

## 重构流程

```
1. 识别目标 → 2. 读所有引用 → 3. 写/检查测试 → 4. 小步重构 → 5. 运行测试 → 6. 构建验证 → (循环 4-6)
```

### 小步提交建议

- 每个逻辑独立的改变作为一个步骤
- 每步完成后运行 `npm run build` 确保无编译错误
- 每步完成后运行相关测试：`npx tsx --test src/tests/相关测试.test.ts`
- **不要**在一次编辑中混合重构和功能修改

### 当重构出错时

如果某步重构导致测试失败：

1. 立即回滚该步骤（`git checkout -- <file>` 或 `git revert`）
2. 重新理解代码的行为
3. 缩小重构范围，分更小的步骤重试

---

## 避免的事项

- ❌ 大规模重命名（除非有 100% 的 grep 覆盖和测试覆盖）
- ❌ 修改公共 API 格式（CLI 参数、配置格式、持久化文件格式）
- ❌ 升级依赖版本（独立于重构的任务）
- ❌ 重构 + 功能开发混合在一次提交中
- ❌ 改变代码格式化风格（缩进、引号风格等）
- ❌ 删除"看起来没用"的代码（可能是不明显但必要的边界情况处理）
