import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ToolExecutionContext, ToolExecutionResult, ToolExecutionFollowUpMessage } from "./executor";

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
