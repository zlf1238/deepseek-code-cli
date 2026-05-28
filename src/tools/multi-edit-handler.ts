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

  // ── 第一阶段：按文件分组，每个文件只读取一次 ────────────────
  type FileGroup = {
    absPath: string;
    metadata: FileReadMetadata;
    edits: EditOperation[];
  };

  const fileGroups = new Map<string, FileGroup>();

  for (const edit of edits) {
    const absPath = normalizeFilePath(edit.file_path);
    if (!path.isAbsolute(absPath)) {
      continue;
    }

    if (!fileGroups.has(absPath)) {
      try {
        const metadata = readTextFileWithMetadata(absPath);
        fileGroups.set(absPath, { absPath, metadata, edits: [] });
      } catch {
        fileGroups.set(absPath, {
          absPath,
          metadata: { content: "", encoding: "utf8", lineEndings: "LF", timestamp: 0 },
          edits: [],
        });
      }
    }
    fileGroups.get(absPath)!.edits.push(edit);
  }

  // ── 第二阶段：每个文件在内存中顺序应用所有编辑，全部通过后一次性写回 ──
  const results: Array<{ file_path: string; ok: boolean; replaced: number; error?: string }> = [];

  for (const [absPath, group] of fileGroups) {
    const { metadata, edits: fileEdits } = group;

    if (!metadata.content && fileEdits.length > 0) {
      for (const edit of fileEdits) {
        results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "File not found" });
      }
      continue;
    }

    let content = metadata.content;
    let fileOk = true;

    for (const edit of fileEdits) {
      if (!path.isAbsolute(normalizeFilePath(edit.file_path))) {
        results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "file_path must be absolute" });
        fileOk = false;
        continue;
      }

      try {
        if (edit.replace_all) {
          const expected = edit.expected_occurrences;
          let exactCount = countOccurrences(content, edit.old_string);

          if (exactCount === 0) {
            const matches = findMatchesInContent(content, edit.old_string, absPath);
            if (matches.length > 0) {
              exactCount = matches.length;
              if (expected !== undefined && exactCount !== expected) {
                results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: `Expected ${expected} occurrences, found ${exactCount}` });
                fileOk = false;
                continue;
              }
              content = applyReplacements(content, matches, edit.new_string);
              results.push({ file_path: edit.file_path, ok: true, replaced: exactCount });
              continue;
            }
          }

          if (expected !== undefined && exactCount !== expected) {
            results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: `Expected ${expected} occurrences, found ${exactCount}` });
            fileOk = false;
            continue;
          }

          if (exactCount === 0) {
            results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "old_string not found" });
            fileOk = false;
            continue;
          }

          content = content.split(edit.old_string).join(edit.new_string);
          results.push({ file_path: edit.file_path, ok: true, replaced: exactCount });
        } else {
          const index = content.indexOf(edit.old_string);
          if (index !== -1) {
            content = content.slice(0, index) + edit.new_string + content.slice(index + edit.old_string.length);
            results.push({ file_path: edit.file_path, ok: true, replaced: 1 });
          } else {
            const matches = findMatchesInContent(content, edit.old_string, absPath);
            if (matches.length > 0) {
              const match = matches[0];
              content = content.slice(0, match.startOffset) + edit.new_string + content.slice(match.endOffset);
              results.push({ file_path: edit.file_path, ok: true, replaced: 1 });
            } else {
              results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: "old_string not found" });
              fileOk = false;
            }
          }
        }
      } catch (err) {
        results.push({ file_path: edit.file_path, ok: false, replaced: 0, error: String(err) });
        fileOk = false;
      }
    }

    if (fileOk) {
      writeTextFile(absPath, content, metadata.encoding, metadata.lineEndings);
      recordFileState(context.sessionId, {
        filePath: absPath,
        content,
        timestamp: Date.now(),
        encoding: metadata.encoding,
        lineEndings: metadata.lineEndings,
      });
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

function applyReplacements(raw: string, matches: MatchOccurrence[], replacement: string): string {
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
