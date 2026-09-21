import { client, config } from "./llm.js";
import { checkPermission, type PermMode } from "./permissions.js";
import { toolMap, toolSpecs } from "./tools.js";

export type IO = {
  out: (text: string) => void;
  ask: (question: string) => Promise<string>;
};

export type Usage = { prompt: number; completion: number; cost: number };

/**
 * Run one user turn to completion: call the model, stream its reply, execute any
 * tool calls (through the permission gate), feed results back, and repeat until
 * the model responds with no tool calls. Mutates `messages` in place and reports
 * each new message via `onMessage` (for session persistence).
 */
export async function runTurn(
  messages: any[],
  io: IO,
  mode: PermMode,
  onMessage: (message: any) => void,
): Promise<Usage> {
  const usage: Usage = { prompt: 0, completion: 0, cost: 0 };
  const specs = toolSpecs();

  for (;;) {
    // `usage: { include: true }` is an OpenRouter extension (per-request cost in
    // `usage.cost`) that isn't in the OpenAI types, so the params are cast.
    const stream = (await client().chat.completions.create({
      model: config.model,
      messages,
      tools: specs,
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
    } as any)) as unknown as AsyncIterable<any>;

    let content = "";
    let printedText = false;
    const toolCalls: any[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        io.out(delta.content);
        content += delta.content;
        printedText = true;
      }
      // Tool-call fragments arrive split across chunks; merge them by index.
      for (const tc of delta?.tool_calls ?? []) {
        toolCalls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const call = toolCalls[tc.index];
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.function.name += tc.function.name;
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
      if (chunk.usage) {
        usage.prompt += chunk.usage.prompt_tokens ?? 0;
        usage.completion += chunk.usage.completion_tokens ?? 0;
        usage.cost += (chunk.usage as any).cost ?? 0;
      }
    }
    if (printedText) io.out("\n");

    const assistant: any = { role: "assistant", content: content || null };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    messages.push(assistant);
    onMessage(assistant);

    if (toolCalls.length === 0) return usage; // model is done for this turn

    for (const call of toolCalls) {
      const result = await runTool(call, io, mode);
      const toolMessage = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      onMessage(toolMessage);
    }
    // loop: the model now sees the tool results
  }
}

async function runTool(call: any, io: IO, mode: PermMode): Promise<string> {
  const tool = toolMap.get(call.function.name);
  if (!tool) return `Error: unknown tool ${call.function.name}`;

  let args: any;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return `Error: could not parse arguments for ${tool.name}`;
  }

  io.out(`\n  ⚙ ${tool.name} ${preview(args)}\n`);
  const permission = await checkPermission(tool, args, mode, io.ask);
  if (!permission.ok) return `Tool call rejected: ${permission.reason}`;

  try {
    const result = await tool.run(tool.parameters.parse(args));
    io.out(`  ↳ ${truncate(result, 400)}\n`);
    return result;
  } catch (e: any) {
    const message = `Error: ${e.message}`;
    io.out(`  ↳ ${message}\n`);
    return message;
  }
}

function preview(args: any): string {
  return String(args.command ?? args.path ?? "").slice(0, 80);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}
