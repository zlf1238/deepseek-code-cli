/** Ink 终端输入 hook：拦截原始 stdin 数据，支持 bracketed paste 模式 */
import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import { parseTerminalInput, NO_MODIFIERS, type InputKey } from "./parseTerminalInput";

type InputHandler = (input: string, key: InputKey) => void;

/**
 * 自定义终端输入 hook。
 * 替代 Ink 的 useInput，支持 bracketed paste mode 和更精确的按键解析。
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

  useEffect(() => {
    if (!isActive || !stdin) {
      return;
    }

    let pasteBuffer = "";
    let isPasting = false;

    const processNormal = (raw: string): void => {
      const { input, key } = parseTerminalInput(raw);
      if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
        inputHandler(input, key);
      }
    };

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
            inputHandler(cleaned, NO_MODIFIERS);
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
      stdin.off("data", handleData);
    };
  }, [isActive, stdin, inputHandler]);
}
