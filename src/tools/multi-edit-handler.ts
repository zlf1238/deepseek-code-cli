import * as path from "path";
import { readTextFileWithMetadata, writeTextFile, type FileReadMetadata } from "./file-utils";
import { normalizeFilePath, recordFileState } from "./state";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

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
        if (expected !== undefined) {
          const count = countOccurrences(content, edit.old_string);
          if (count !== expected) {
            results.push({
              file_path: edit.file_path, ok: false, replaced: 0,
              error: `Expected ${expected} occurrences, found ${count}`,
            });
            continue;
          }
        }
        const newContent = content.split(edit.old_string).join(edit.new_string);
        const replaced = countOccurrences(content, edit.old_string);
        writeTextFile(absPath, newContent, metadata.encoding, metadata.lineEndings);
        recordFileState(context.sessionId, {
          filePath: absPath,
          content: newContent,
          timestamp: Date.now(),
          encoding: metadata.encoding,
          lineEndings: metadata.lineEndings,
        });
        results.push({ file_path: edit.file_path, ok: true, replaced });
      } else {
        const index = content.indexOf(edit.old_string);
        if (index === -1) {
          results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "old_string not found" });
          continue;
        }
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
