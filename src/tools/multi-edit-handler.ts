import * as path from "path";
import { readTextFileWithMetadata, writeTextFile, type FileReadMetadata } from "./file-utils";
import { normalizeFilePath, recordFileState } from "./state";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import { findOccurrences, type SearchScope, type MatchOccurrence } from "./edit-handler";

type EditOperation = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  expected_occurrences?: number;
};

export async function handleMultiEditTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const rawEdits = args.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { ok: false, name: "multi_edit", error: "\"edits\" must be a non-empty array." };
  }

  const edits: EditOperation[] = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const e = rawEdits[i];
    if (!e || typeof e !== "object") {
      return { ok: false, name: "multi_edit", error: `Edit at index ${i} must be an object.` };
    }
    const rec = e as Record<string, unknown>;
    const filePath = typeof rec.file_path === "string" ? rec.file_path.trim() : "";
    const oldStr = typeof rec.old_string === "string" ? rec.old_string : "";
    const newStr = typeof rec.new_string === "string" ? rec.new_string : "";
    if (!filePath) {
      return { ok: false, name: "multi_edit", error: `Edit at index ${i} missing "file_path".` };
    }
    if (oldStr === newStr) {
      return { ok: false, name: "multi_edit", error: `Edit at index ${i}: new_string must differ from old_string.` };
    }
    edits.push({
      file_path: path.isAbsolute(filePath) ? filePath : path.join(context.projectRoot, filePath),
      old_string: oldStr,
      new_string: newStr,
      replace_all: rec.replace_all === true,
      expected_occurrences: typeof rec.expected_occurrences === "number" ? rec.expected_occurrences : undefined,
    });
  }

  const results: Array<{ file_path: string; ok: boolean; replaced: number; error?: string }> = [];

  for (const edit of edits) {
    try {
      const absPath = normalizeFilePath(edit.file_path);
      if (!path.isAbsolute(absPath)) {
        results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "file_path must be absolute" });
        continue;
      }

      // 使用 file-utils 读取（自动检测编码+换行符）
      let metadata: FileReadMetadata;
      try {
        metadata = readTextFileWithMetadata(absPath);
      } catch {
        results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "File not found" });
        continue;
      }

      const content = metadata.content;

      if (edit.replace_all) {
        const expected = edit.expected_occurrences;

        // 先尝试精确匹配计数
        let exactCount = countOccurrences(content, edit.old_string);

        // 如果精确匹配为 0，尝试 CRLF 归一化匹配（兼容 \r 差异）
        if (exactCount === 0) {
          const matches = findMatchesInContent(content, edit.old_string, absPath);
          if (matches.length > 0) {
            exactCount = matches.length;
            // 用 findOccurrences 找到的匹配进行替换
            if (expected !== undefined && exactCount !== expected) {
              results.push({
                file_path: edit.file_path, ok: false, replaced: 0,
                error: `Expected ${expected} occurrences, found ${exactCount}`,
              });
              continue;
            }
            const newContent = applyReplacements(content, matches, edit.new_string);
            writeTextFile(absPath, newContent, metadata.encoding, metadata.lineEndings);
            recordFileState(context.sessionId, {
              filePath: absPath,
              content: newContent,
              timestamp: Date.now(),
              encoding: metadata.encoding,
              lineEndings: metadata.lineEndings,
            });
            results.push({ file_path: edit.file_path, ok: true, replaced: exactCount });
            continue;
          }
        }

        if (expected !== undefined && exactCount !== expected) {
          results.push({
            file_path: edit.file_path, ok: false, replaced: 0,
            error: `Expected ${expected} occurrences, found ${exactCount}`,
          });
          continue;
        }

        if (exactCount === 0) {
          results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "old_string not found" });
          continue;
        }

        const newContent = content.split(edit.old_string).join(edit.new_string);
        writeTextFile(absPath, newContent, metadata.encoding, metadata.lineEndings);
        recordFileState(context.sessionId, {
          filePath: absPath,
          content: newContent,
          timestamp: Date.now(),
          encoding: metadata.encoding,
          lineEndings: metadata.lineEndings,
        });
        results.push({ file_path: edit.file_path, ok: true, replaced: exactCount });
      } else {
        // 单次替换：优先精确匹配，失败后降级到 CRLF 归一化匹配
        const index = content.indexOf(edit.old_string);
        if (index !== -1) {
          const newContent = content.slice(0, index) + edit.new_string + content.slice(index + edit.old_string.length);
          writeTextFile(absPath, newContent, metadata.encoding, metadata.lineEndings);
          recordFileState(context.sessionId, {
            filePath: absPath,
            content: newContent,
            timestamp: Date.now(),
            encoding: metadata.encoding,
            lineEndings: metadata.lineEndings,
          });
          results.push({ file_path: edit.file_path, ok: true, replaced: 1 });
        } else {
          // CRLF 归一化匹配降级
          const matches = findMatchesInContent(content, edit.old_string, absPath);
          if (matches.length > 0) {
            const match = matches[0];
            const newContent = content.slice(0, match.startOffset) +
              edit.new_string +
              content.slice(match.endOffset);
            writeTextFile(absPath, newContent, metadata.encoding, metadata.lineEndings);
            recordFileState(context.sessionId, {
              filePath: absPath,
              content: newContent,
              timestamp: Date.now(),
              encoding: metadata.encoding,
              lineEndings: metadata.lineEndings,
            });
            results.push({ file_path: edit.file_path, ok: true, replaced: 1 });
          } else {
            results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "old_string not found" });
          }
        }
      }
    } catch (err) {
      results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: String(err) });
    }
  }

  const allOk = results.every((r) => r.ok);
  const summary = results
    .map((r) => `  ${r.ok ? "✓" : "✗"} ${r.file_path}${r.error ? ` — ${r.error}` : ` (${r.replaced} replaced)`}`)
    .join("\n");

  return {
    ok: allOk,
    name: "multi_edit",
    output: `${results.length} edit(s):\n${summary}`,
    metadata: { edits: results },
  };
}

/**
 * 在文件内容中查找所有匹配项，使用 CRLF 归一化匹配。
 */
function findMatchesInContent(content: string, needle: string, filePath: string): MatchOccurrence[] {
  const lines = content.split("\n");
  const scope: SearchScope = {
    filePath,
    startOffset: 0,
    endOffset: content.length,
    startLine: 1,
    endLine: lines.length,
    snippetId: null,
  };
  return findOccurrences(content, needle, scope);
}

/**
 * 按匹配结果从后向前替换（避免偏移错乱）。
 */
function applyReplacements(raw: string, matches: MatchOccurrence[], replacement: string): string {
  // 从后向前替换，避免破坏后续匹配的偏移
  const sorted = [...matches].sort((a, b) => b.startOffset - a.startOffset);
  let result = raw;
  for (const match of sorted) {
    result = result.slice(0, match.startOffset) + replacement + result.slice(match.endOffset);
  }
  return result;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
