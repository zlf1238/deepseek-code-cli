/**
 * pi TUI 入口 —— 使用 PiApp 主循环。
 * 启动方式: deepseek-code （默认）
 * Ink 回退: PI_INK=1 deepseek-code
 */
import { PiApp } from "./ui/PiApp";

export async function startPiTui(model: string): Promise<void> {
  const app = new PiApp(process.cwd(), model);
  await app.start();
}
