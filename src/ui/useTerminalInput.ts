/** Ink 终端输入 hook：拦截原始 stdin 数据，支持 bracketed paste 模式 */
import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import { parseTerminalInput, NO_MODIFIERS, type InputKey } from "./parseTerminalInput";

type InputHandler = (input: string, key: InputKey) => void;

/**
 * 自定义终端输入 hook。
 * 替代 Ink 的 useInput，支持 bracketed paste mode 和更精确的按键解析。
 *
 * 核心优化：使用 setImmediate 批处理输入事件。
 * 在 WSL ConPTY 环境下，Ink 每次渲染会写 stdout，而 ConPTY 的
 * stdin/stdout 共享同一管道，渲染期间的 stdout 写入会阻塞 stdin
 * 事件投递，导致快速按键丢失。通过 setImmediate 将同一 I/O 轮次
 * 内的所有按键累积后一次性处理，React 批量更新状态只触发一次渲染，
 * 大幅减少 stdout 写入频率，消除 ConPTY 管道竞争。
 *
 * @param inputHandler 输入处理回调
 * @param isActive 是否激活（为 false 时不监听）
 */
export function useTerminalInput(
  inputHandler: InputHandler,
  isActive: boolean,
): void {
  const { stdin } = useStdin();
  const internal_exitOnCtrlC = false;

  // 用 ref 存储 handler，避免因引用变化导致 useEffect 重建 stdin 监听器
  const handlerRef = useRef(inputHandler);
  handlerRef.current = inputHandler;

  useEffect(() => {
    if (!isActive || !stdin) {
      return;
    }

    let pasteBuffer = "";
    let isPasting = false;

    // ── 输入批处理 ──
    // 累积解析后的按键事件，在 setImmediate 回调中一次性投递给 React。
    // 同一 I/O 轮次内的多个 data 事件会被合并为一次 handlerRef.current 调用，
    // React 18 自动批处理会将多个 setBuffer 合并为一次渲染。
    let pendingInputs: Array<{ input: string; key: InputKey }> = [];
    let flushHandle: ReturnType<typeof setImmediate> | null = null;

    const flushPendingInputs = (): void => {
      flushHandle = null;
      const inputs = pendingInputs;
      pendingInputs = [];
      for (const { input, key } of inputs) {
        handlerRef.current(input, key);
      }
    };

    const scheduleFlush = (): void => {
      if (flushHandle === null) {
        flushHandle = setImmediate(flushPendingInputs);
      }
    };

    const enqueueInput = (input: string, key: InputKey): void => {
      pendingInputs.push({ input, key });
      scheduleFlush();
    };

    const processNormal = (raw: string): void => {
      const { input, key } = parseTerminalInput(raw);
      if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
        enqueueInput(input, key);
      }
    };

    // 启用 bracketed paste mode：终端会将粘贴内容包裹在 \x1b[200~ ... \x1b[201~ 中，
    // 使多行粘贴内容中的换行符能被正确识别，而非被解析为回车键。
    process.stdout.write("\x1b[?2004h");

    const handleData = (data: Buffer | string): void => {
      const raw = String(data);

      // Bracketed paste mode: pasted content wrapped in \u001B[200~...\u001B[201~
      if (isPasting) {
        const endIdx = raw.indexOf("\u001B[201~");
        if (endIdx >= 0) {
          pasteBuffer += raw.slice(0, endIdx);
          isPasting = false;
          const cleaned = pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          if (cleaned) {
            enqueueInput(cleaned, NO_MODIFIERS);
          }
          pasteBuffer = "";
          const remaining = raw.slice(endIdx + 6);
          if (remaining) {
            processNormal(remaining);
          }
        } else {
          pasteBuffer += raw;
        }
        return;
      }

      if (raw.startsWith("\u001B[200~")) {
        isPasting = true;
        pasteBuffer = "";
        const afterStart = raw.slice(6); // "\u001B[200~".length === 6
        if (afterStart) {
          handleData(afterStart);
        }
        return;
      }

      processNormal(raw);
    };

    stdin.on("data", handleData);
    return () => {
      // 禁用 bracketed paste mode，恢复终端默认行为
      process.stdout.write("\x1b[?2004l");

      // 清理时立即投递所有待处理输入，避免丢失
      if (flushHandle !== null) {
        clearImmediate(flushHandle);
        flushHandle = null;
      }
      if (pendingInputs.length > 0) {
        const inputs = pendingInputs;
        pendingInputs = [];
        for (const { input, key } of inputs) {
          handlerRef.current(input, key);
        }
      }
      stdin.off("data", handleData);
    };
  }, [isActive, stdin]);
}
