/**
 * 借鉴 Reasonix repair/storm.ts: 检测同一 (tool, args) 在滑动窗口内重复出现，
 * 阻止模型陷入死循环工具调用。
 *
 * 写入类调用清空之前的只读条目（文件状态已变，重读不算重复）。
 * 连续 3 次相同 (name, args) 触发抑制。
 */

import type { ToolCall } from "../tools/executor";

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

/** 写入类工具名称列表——调用后会改变文件/系统状态。 */
const MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "bash", "run_background"]);

export class StormBreaker {
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly recent: RecentEntry[] = [];

  constructor(windowSize = 6, threshold = 3) {
    this.windowSize = windowSize;
    this.threshold = threshold;
  }

  inspect(call: ToolCall): { suppress: boolean; reason?: string } {
    const name = call.function?.name;
    if (!name) return { suppress: false };
    const args = call.function?.arguments ?? "";
    const mutating = MUTATING_TOOLS.has(name);
    const readOnly = !mutating;

    if (mutating) {
      // 写入操作后清空只读历史——文件状态已变化
      for (let i = this.recent.length - 1; i >= 0; i--) {
        if (this.recent[i]!.readOnly) this.recent.splice(i, 1);
      }
    }

    const count = this.recent.reduce(
      (n, e) => (e.name === name && e.args === args ? n + 1 : n),
      0,
    );

    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason: `${name} 以相同参数调用了 ${count + 1} 次——重复循环防护已触发`,
      };
    }

    this.recent.push({ name, args, readOnly });
    while (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }

  reset(): void {
    this.recent.length = 0;
  }
}
