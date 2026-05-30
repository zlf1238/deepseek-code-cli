/**
 * pi TUI 版本的会话列表组件。
 * 功能：浏览会话、搜索过滤、批量删除模式。
 *
 * 注意：当前版本将搜索简化为逐字符过滤（原 Ink 版本的实时搜索），
 * 删除模式也保留。OVERHEAD_LINES 计算在父组件处理。
 */
import type { SelectItem, SelectListTheme } from "../tui/components/select-list";
import { SelectList } from "../tui/components/select-list";
import type { Component } from "../tui/tui";
import type { SessionEntry } from "../session";
import { Theme } from "../tui/ThemeAdapter";

/** 会话列表模式 */
type Mode = "browse" | "search" | "delete";

/** 组件主题 */
const sessionListTheme: SelectListTheme = {
  selectedPrefix: Theme.selectedPrefix,
  selectedText: Theme.selectedText,
  description: Theme.description,
  scrollInfo: Theme.dimText,
  noMatch: Theme.dimText,
};

/** 格式化会话标题（导出供测试使用） */
export function formatSessionTitle(value: string, max = 70): string {
  const cleaned = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

/** 格式化时间戳 */
function formatTimestamp(value: string): string {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return date.toLocaleString();
  } catch {
    return value;
  }
}

/** pi 版本的会话选择列表 */
export class PiSessionList implements Component {
  private selectList: SelectList;
  private allSessions: SessionEntry[] = [];
  private mode: Mode = "browse";
  private searchQuery = "";
  private selectedIds = new Set<string>();
  private onSelectCb?: (sessionId: string) => void;
  private onCancelCb?: () => void;
  private onDeleteCb?: (sessionIds: string[]) => void;
  private maxVisible: number;

  constructor(maxVisible: number) {
    this.maxVisible = Math.max(3, maxVisible);
    this.selectList = new SelectList({
      maxVisible: this.maxVisible,
      layout: { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 60 },
      theme: sessionListTheme,
    });
    // 主题在构造函数中已设置
  }

  /** 设置会话数据 */
  setSessions(sessions: SessionEntry[]): void {
    this.allSessions = sessions;
    this.applyFilter();
  }

  /** 选中回调 */
  set onSelect(cb: (sessionId: string) => void) {
    this.onSelectCb = cb;
    this.selectList.onSelect = (item) => {
      if (this.mode === "delete") {
        this.toggleDeleteSelection(item.value);
      } else {
        cb(item.value);
      }
    };
  }

  /** 取消回调 */
  set onCancel(cb: () => void) {
    this.onCancelCb = cb;
    this.selectList.onCancel = cb;
  }

  /** 删除回调 */
  set onDelete(cb: (sessionIds: string[]) => void) {
    this.onDeleteCb = cb;
  }

  /** 获取当前选中的会话 ID */
  get selectedSessionId(): string | undefined {
    const items = this.selectList.getItems();
    const idx = this.selectList.getSelectedIndex();
    return idx >= 0 && idx < items.length ? items[idx].value : undefined;
  }

  /** 设为浏览模式 */
  setMode(mode: Mode): void {
    this.mode = mode;
    if (mode === "browse") {
      this.searchQuery = "";
      this.selectedIds.clear();
      this.applyFilter();
    }
  }

  // ── Component 接口 ──

  render(width: number): string[] {
    return this.selectList.render(width);
  }

  handleInput(keyData: string): void {
    // 搜索模式
    if (this.mode === "search") {
      this.handleSearchInput(keyData);
      return;
    }

    // 删除模式
    if (this.mode === "delete") {
      this.handleDeleteInput(keyData);
      return;
    }

    // 浏览模式 —— 特殊按键
    if (keyData === "/") {
      this.mode = "search";
      this.searchQuery = "";
      return;
    }
    if (keyData === "d" || keyData === "D") {
      this.mode = "delete";
      this.selectedIds.clear();
      return;
    }

    // 浏览模式 —— 委托给 SelectList
    this.selectList.handleInput(keyData);
  }

  // ── 搜索模式 ──

  private handleSearchInput(keyData: string): void {
    if (keyData === "\x1b") {
      // ESC: 退出搜索
      this.mode = "browse";
      this.searchQuery = "";
      this.applyFilter();
      return;
    }
    if (keyData === "\r") {
      // Enter: 确认搜索，切回浏览
      this.mode = "browse";
      return;
    }
    if (keyData === "\x7f" || keyData === "\b") {
      // Backspace: 删除一个字符
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.applyFilter();
      return;
    }
    // 可打印字符
    if (keyData.length === 1 && keyData.charCodeAt(0) >= 32) {
      this.searchQuery += keyData;
      this.applyFilter();
    }
  }

  // ── 删除模式 ──

  private handleDeleteInput(keyData: string): void {
    if (keyData === "\x1b" || keyData === "d" || keyData === "D") {
      // ESC 或 d: 退出删除模式
      this.mode = "browse";
      this.selectedIds.clear();
      return;
    }
    if (keyData === " ") {
      // 空格: 切换选择
      this.toggleSelectedId();
      return;
    }
    if (keyData === "a" || keyData === "A") {
      // a: 全选/取消全选
      const items = this.selectList.getItems();
      if (this.selectedIds.size === items.length) {
        this.selectedIds.clear();
      } else {
        for (const item of items) this.selectedIds.add(item.value);
      }
      return;
    }
    if (keyData === "\r") {
      // Enter: 确认删除
      if (this.selectedIds.size > 0 && this.onDeleteCb) {
        this.onDeleteCb(Array.from(this.selectedIds));
      }
      this.mode = "browse";
      this.selectedIds.clear();
      return;
    }
    // 上下导航委托给 SelectList
    this.selectList.handleInput(keyData);
  }

  private toggleSelectedId(): void {
    const items = this.selectList.getItems();
    const idx = this.selectList.getSelectedIndex();
    if (idx < 0 || idx >= items.length) return;
    const id = items[idx].value;
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
  }

  private toggleDeleteSelection(id: string): void {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
  }

  // ── 过滤 ──

  /** 高亮匹配文本（黄色加粗） */
  private static highlightMatch(text: string, query: string): string {
    if (!query) return text;
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const result: string[] = [];
    let lastIndex = 0;
    let searchFrom = 0;
    while (true) {
      const idx = lower.indexOf(q, searchFrom);
      if (idx === -1) break;
      result.push(text.slice(lastIndex, idx));
      result.push(`\x1b[1;33m${text.slice(idx, idx + q.length)}\x1b[0m`);
      lastIndex = idx + q.length;
      searchFrom = lastIndex;
    }
    result.push(text.slice(lastIndex));
    return result.join("");
  }

  private applyFilter(): void {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = q
      ? this.allSessions.filter((s) => {
          const title = (s.summary || "").toLowerCase();
          const status = (s.status || "").toLowerCase();
          const id = s.id.toLowerCase();
          return title.includes(q) || status.includes(q) || id.includes(q);
        })
      : this.allSessions;

    const items: SelectItem[] = filtered.map((s) => {
      const rawLabel = formatSessionTitle(s.summary || s.id, 50);
      const rawDesc = `${s.status || "unknown"} · ${formatTimestamp(s.updateTime)}`;
      return {
        value: s.id,
        label: q ? PiSessionList.highlightMatch(rawLabel, q) : rawLabel,
        description: q ? PiSessionList.highlightMatch(rawDesc, q) : rawDesc,
      };
    });

    this.selectList.setItems(items);
  }

  // ── 方法暴露给父组件 ──

  get modeLabel(): string {
    if (this.mode === "search") return `搜索: ${this.searchQuery || "…"}  (Esc 退出)`;
    if (this.mode === "delete") return `删除模式: 已选 ${this.selectedIds.size} 个  (空格切换 · a全选 · Enter确认 · Esc退出)`;
    if (this.selectList.getItemCount() === 0) return "Esc: 返回";
    return "↑/↓: 切换 · Enter: 继续 · /: 搜索 · d: 删除 · Esc: 返回";
  }

  invalidate(): void {
    this.selectList.invalidate();
  }
}
