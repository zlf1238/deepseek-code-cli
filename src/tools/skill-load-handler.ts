import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import matter from "gray-matter";
import type { ToolExecutionContext, ToolExecutionResult, ToolExecutionFollowUpMessage } from "./executor";
import { runSkillSubagent } from "./code-executor";

export async function handleSkillLoadTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return {
      ok: false,
      name: "SkillLoad",
      error: "Missing required parameter: name. Check Available Skills in system prompt for valid names.",
    };
  }

  // 通知终端 UI 正在加载 skill（利用 onProcessStart/onProcessExit 钩子）
  const processId = `skillload-${name}`;
  context.onProcessStart?.(processId, `加载 Skill: ${name}`);

  try {
    // Resolve skill paths — user-level first (~/.agents/skills), then project-level
    const homeDir = os.homedir();
    const skillPaths = [
      path.join(homeDir, ".agents", "skills", name, "SKILL.md"),
      path.join(homeDir, ".agents", "skills", `${name}.md`),
      path.join(context.projectRoot, ".deepseek-code", "skills", name, "SKILL.md"),
      path.join(context.projectRoot, ".deepseek-code", "skills", `${name}.md`),
    ];

    let body: string | null = null;
    let skillPath: string | null = null;

    for (const p of skillPaths) {
      try {
        body = fs.readFileSync(p, "utf8");
        skillPath = p;
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!body || !skillPath) {
      // Build available names list for a helpful error
      const availableNames = collectAvailableSkillNames(context.projectRoot);
      return {
        ok: false,
        name: "SkillLoad",
        error: `Unknown skill: "${name}". Available: ${availableNames.join(", ") || "(none)"}`,
      };
    }

    // ── 解析 frontmatter 决定 runAs 模式 ──
    let runAs: string;
    let skillContent: string;
    let frontmatter: Record<string, unknown> = {};
    try {
      const parsed = matter(body);
      frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
      runAs = typeof frontmatter.runAs === "string" ? frontmatter.runAs : "inline";
      skillContent = parsed.content;
    } catch {
      return {
        ok: false,
        name: "SkillLoad",
        error: `Failed to parse skill file for \"${name}\". The SKILL.md file may be corrupted.`,
        metadata: { failureCode: "AMBIGUOUS" as any },
    };
  }

  // ── Subagent 模式：委派给 Flash 子智能体执行 ──
  if (runAs === "subagent") {
    const allowedTools = Array.isArray(frontmatter["allowed-tools"])
      ? (frontmatter["allowed-tools"] as string[])
      : undefined;
    const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
    const maxToolIters = typeof frontmatter["max-tool-iters"] === "number"
      ? (frontmatter["max-tool-iters"] as number)
      : undefined;

    return await runSkillSubagent(
      context,
      skillContent,
      `Execute the "${name}" skill on the current project.`,
      model,
      allowedTools,
      maxToolIters,
      context.shouldStop,
      "SkillLoad",
    );
  }

  // ── Inline 模式（默认）：正文注入当前会话 ──
  const followUpMessages: ToolExecutionFollowUpMessage[] = [
    {
      role: "system",
      content: [
        `Use the skill document below to assist the user:`,
        ``,
        `<${name}-skill path="${skillPath}">`,
        body,
        `</${name}-skill>`,
      ].join("\n"),
    },
  ];

  return {
    ok: true,
    name: "SkillLoad",
    output: `Loaded skill "${name}" (${body.length} chars, ${skillPath}).`,
    metadata: { skillName: name, charCount: body.length, path: skillPath },
    followUpMessages,
  };
  } finally {
    // 延迟 exit 给 React 一个渲染周期，让用户看到"加载 Skill"提示
    setTimeout(() => context.onProcessExit?.(processId), 0);
  }
}

/** Collect skill names from both user-level and project-level directories. */
function collectAvailableSkillNames(projectRoot: string): string[] {
  const homeDir = os.homedir();
  const roots = [
    path.join(homeDir, ".agents", "skills"),
    path.join(projectRoot, ".deepseek-code", "skills"),
  ];

  const names = new Set<string>();

  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(dir, entry.name, "SKILL.md");
        if (fs.existsSync(skillPath)) {
          names.add(entry.name);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        names.add(entry.name.replace(/\.md$/, ""));
      }
    }
  }

  return Array.from(names).sort();
}
