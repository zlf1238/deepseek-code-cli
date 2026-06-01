/** deepseek-code CLI 入口 —— 使用 pi TUI 差分渲染引擎 */
import { App } from "./ui/App";
import { promptForPendingUpdate, checkForNpmUpdate, type PackageInfo } from "./updateCheck";

const args = process.argv.slice(2);
const packageInfo = readPackageInfo();

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${packageInfo.version || "unknown"}\n`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "deepseek-code - DeepSeek Code CLI",
      "",
      "Usage:",
      "  deepseek-code               Launch the interactive TUI in the current directory",
      "  deepseek-code --version     Print the version",
      "  deepseek-code --help        Show this help",
      "",
      "Configuration:",
      "  ~/.deepseek-code/settings.json   API key, model, base URL",
      "  ~/.agents/skills/*/SKILL.md  User-level skills",
      "  ./.deepseek-code/skills/*/SKILL.md Project-level skills",
      "",
      "Inside the TUI:",
      "  enter            Send the prompt",
      "  shift+enter      Insert a newline",
      "  home/end         Move within the current line",
      "  alt+left/right   Move by word",
      "  ctrl+w           Delete the previous word",
      "  ctrl+v           Paste an image from the clipboard",
      "  ctrl+x           Clear pasted images",
      "  esc              Interrupt the current model turn",
      "  /                Open the skills/commands menu",
      "  /new             Start a fresh conversation",
      "  /resume          选择一个历史会话继续对话",
      "  /exit            Quit",
      "  ctrl+d twice     Quit"
    ].join("\n") + "\n"
  );
  process.exit(0);
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    "deepseek-code requires an interactive terminal (TTY). " +
      "Re-run from a real terminal session.\n"
  );
  process.exit(1);
}

void main();

async function main(): Promise<void> {
  // 启动前检查是否有待处理更新
  await promptForPendingUpdate(packageInfo);

  // 后台异步检查新版本（不阻塞启动）
  void checkForNpmUpdate(packageInfo);

  const app = new App(process.cwd(), packageInfo.version || "deepseek-code");
  await app.start();
}

function readPackageInfo(): PackageInfo {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json") as { name?: unknown; version?: unknown };
    return {
      name: typeof pkg.name === "string" ? pkg.name : "@vegamo/deepseek-code-cli",
      version: typeof pkg.version === "string" ? pkg.version : ""
    };
  } catch {
    return { name: "@vegamo/deepseek-code-cli", version: "" };
  }
}
