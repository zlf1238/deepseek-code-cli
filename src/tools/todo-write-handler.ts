import type { ToolExecutionContext, ToolExecutionResult } from "./executor";

type TodoItem = {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
};

export async function handleTodoWriteTool(
  args: Record<string, unknown>,
  _context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const rawTodos = args.todos;

  // Allow clearing the list
  if (Array.isArray(rawTodos) && rawTodos.length === 0) {
    return {
      ok: true,
      name: "todo_write",
      output: "Todo list cleared.",
      metadata: { todos: [] },
    };
  }

  if (!Array.isArray(rawTodos) || rawTodos.length === 0) {
    return {
      ok: false,
      name: "todo_write",
      error: "\"todos\" must be an array. Pass [] to clear.",
    };
  }

  const todos: TodoItem[] = [];
  let inProgressCount = 0;

  for (let i = 0; i < rawTodos.length; i++) {
    const item = rawTodos[i];
    if (!item || typeof item !== "object") {
      return { ok: false, name: "todo_write", error: `Todo at index ${i} must be an object.` };
    }
    const rec = item as Record<string, unknown>;

    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (!content) {
      return { ok: false, name: "todo_write", error: `Todo at index ${i} missing "content".` };
    }

    const activeForm = typeof rec.activeForm === "string" ? rec.activeForm.trim() : content;
    const status = rec.status === "in_progress" ? "in_progress" as const
      : rec.status === "completed" ? "completed" as const
      : "pending" as const;

    if (status === "in_progress") inProgressCount++;

    todos.push({ content, activeForm, status });
  }

  if (inProgressCount > 1) {
    return {
      ok: false,
      name: "todo_write",
      error: `Only one todo may be "in_progress" at a time. Found ${inProgressCount}.`,
    };
  }

  const summary = todos.map((t) => {
    const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○";
    return `  ${icon} ${t.status === "in_progress" ? t.activeForm : t.content}`;
  }).join("\n");

  return {
    ok: true,
    name: "todo_write",
    output: `Todo list (${todos.length} items):\n${summary}`,
    metadata: { todos },
  };
}
