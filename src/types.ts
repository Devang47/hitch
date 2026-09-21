/** Shared cross-module types. Domain types (Tool, PermMode) live with their modules. */

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type Usage = { prompt: number; completion: number; cost: number };

/** Terminal I/O seam — lets the agent loop run without a real TTY (tests, pipes). */
export type IO = {
  out: (text: string) => void;
  ask: (question: string) => Promise<string>;
};
