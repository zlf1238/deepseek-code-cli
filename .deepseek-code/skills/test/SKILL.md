---
name: test
description: 运行项目测试套件，诊断失败，提出修复方案并重跑直到通过。子智能体模式——在隔离的 Flash 子智能体中运行测试，诊断并报告失败。
runAs: subagent
---

# Test Skill

## Quick Start

当用户要求你运行测试时，按以下流程操作：

1. **检测项目类型** — 寻找 `package.json`(npm/yarn/pnpm), `pytest`/`pyproject.toml`, `go.mod`, `Cargo.toml` 等
2. **运行测试** — 使用合适的命令（`npm test`, `pytest`, `go test ./...`, `cargo test`）
3. **分析失败** — 读取失败日志，定位失败的文件和行号
4. **诊断根因** — 读取失败的测试文件和相关源文件，找出根本原因
5. **提出修复** — 使用 `edit` 或 `multi_edit` 修复问题
6. **重跑测试** — 再次运行同一测试命令验证修复
7. **最多 3 次修复尝试** — 如果同一失败修复 2 次仍未解决，停下来向用户报告

## 检测命令

根据项目根目录的文件选择测试命令：

```bash
# Node.js
npm test
npx vitest run
npx jest

# Python
pytest
python -m pytest

# Go
go test ./...

# Rust
cargo test
```

## 输出格式

```
▸ running `npm test` ...
  ✓ 15 passed
  ✗ 2 failed: tests/foo.test.ts:42, tests/bar.test.ts:18

▸ diagnosing tests/foo.test.ts:42 ...
  (read 文件内容 + 根因分析)

▸ fixing tests/foo.test.ts ...
  (edit 操作)

▸ re-running `npm test` ...
  ✓ 16 passed
  ✗ 1 failed: tests/bar.test.ts:18

▸ diagnosing tests/bar.test.ts:18 ...
  (read 文件内容 + 根因分析)

▸ fixing tests/bar.test.ts ...
  (edit 操作)

▸ re-running `npm test` ...
  ✓ 17 passed
```

## 注意事项

- 运行测试前先确认命令是否安全（不连接外部服务、不写文件到项目外）
- 如果测试命令需要特殊环境变量或参数，先询问用户
- 同一失败修复 2 次仍未解决时，向用户报告失败原因和已尝试的方案
- 测试通过后，不要做"测试补充"——除非用户明确要求
