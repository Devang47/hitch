import { c } from "../colors.js";
import type { IO, Message, ToolCall, Usage } from "../types.js";
import { client, config } from "./llm.js";
import { checkPermission, type PermMode } from "./permissions.js";
import { toolMap, toolSpecs } from "./tools.js";

/**
 * Run one user turn to completion: call the model, stream its reply, execute any
 * tool calls (through the permission gate), feed results back, and repeat until
 * the model responds with no tool calls. Mutates `messages` in place and reports
 * each new message via `onMessage` (for session persistence).
 */
export async function runTurn(
  messages: Message[],
  io: IO,
  mode: PermMode,
  onMessage: (message: Message) => void,
): Promise<Usage> {
  const usage: Usage = { prompt: 0, completion: 0, cost: 0 };
  const specs = toolSpecs();

  for (;;) {
    // Fallback chain: [primary, ...fallbacks] as OpenRouter's `models` param.
    // Undefined (no fallbacks) is dropped from the body, leaving plain `model`.
    const models = config.fallbacks.length ? [config.model, ...config.fallbacks] : undefined;

    let content = "";
    let printedText = false;
    const toolCalls: ToolCall[] = [];

    // Spinner covers the wait for the first token (and any connect/HTTP error);
    // cleared the instant output starts so it never interleaves with the reply.
    const stopSpinner = startSpinner("thinking");
    try {
      // `usage: { include: true }` is an OpenRouter extension (per-request cost in
      // `usage.cost`) that isn't in the OpenAI types, so the params are cast.
      const stream = (await client().chat.completions.create({
        model: config.model,
        models, // OpenRouter fallback chain; dropped when undefined
        messages: withCaching(messages, config.model),
        tools: specs,
        max_tokens: config.maxTokens,
        provider: config.provider, // OpenRouter routing; dropped from the body when undefined
        stream: true,
        stream_options: { include_usage: true },
        usage: { include: true },
      } as any)) as unknown as AsyncIterable<any>;

      for await (const chunk of stream) {
        stopSpinner(); // first chunk arrived → drop the spinner before printing
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          io.out(delta.content);
          content += delta.content;
          printedText = true;
        }
        // Tool-call fragments arrive split across chunks; merge them by index.
        for (const tc of delta?.tool_calls ?? []) {
          toolCalls[tc.index] ??= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          const call = toolCalls[tc.index]!; // just ensured present on the line above
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
    } finally {
      stopSpinner(); // idempotent: also clears on error / empty stream
    }
    if (printedText) io.out("\n");

    const assistant: Message = { role: "assistant", content: content || null };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    messages.push(assistant);
    onMessage(assistant);

    if (toolCalls.length === 0) return usage; // model is done for this turn

    for (const call of toolCalls) {
      const result = await runTool(call, io, mode);
      const toolMessage: Message = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      onMessage(toolMessage);
    }
    // loop: the model now sees the tool results
  }
}

async function runTool(call: ToolCall, io: IO, mode: PermMode): Promise<string> {
  const tool = toolMap.get(call.function.name);
  if (!tool) return `Error: unknown tool ${call.function.name}`;

  let args: any;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return `Error: could not parse arguments for ${tool.name}`;
  }

  io.out(`\n  ${c.cyan("⚙")} ${c.bold(tool.name)} ${c.dim(preview(args))}\n`);
  const permission = await checkPermission(tool, args, mode, io.ask);
  if (!permission.ok) return `Tool call rejected: ${permission.reason}`;

  try {
    // Built-ins validate/normalize with zod; MCP tools carry no zod schema, so
    // pass their args straight through (the server validates its own input).
    const result = await tool.run(tool.parameters ? tool.parameters.parse(args) : args);
    io.out(`  ${c.dim(`↳ ${truncate(result, 400)}`)}\n`);
    return result;
  } catch (e: any) {
    const message = `Error: ${e.message}`;
    io.out(`  ${c.dim("↳")} ${c.red(message)}\n`);
    return message;
  }
}

/** Add a prompt-caching breakpoint to the (large, stable) system prompt so
 *  repeated turns reuse it. OpenRouter caches automatically for OpenAI/Grok/
 *  DeepSeek and ignores unknown fields, but only Anthropic/Gemini need an
 *  explicit `cache_control`, so we only rewrite to array-form content for those
 *  two — no point risking array content on a provider that doesn't want it. */
function withCaching(messages: Message[], model: string): any[] {
  if (!/^(anthropic|google)\//.test(model)) return messages;
  return messages.map((m) =>
    m.role === "system" && typeof m.content === "string"
      ? { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
      : m,
  );
}

function preview(args: any): string {
  return String(args.command ?? args.path ?? "").slice(0, 80);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}

/** Braille spinner with elapsed seconds, shown while waiting on the model.
 *  Renders on stderr (stdout is owned by the REPL's readline — animating it
 *  there corrupts the line) and rewrites one line: `\r\x1b[K` returns to column
 *  0 and clears to end-of-line each frame, so nothing stacks or leaves residue.
 *  TTY-only: a no-op when stderr is piped, keeping streamed output + tests clean.
 *  Returns an idempotent stop() that erases the line. */
function startSpinner(label: string): () => void {
  const err = process.stderr;
  if (!err.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const start = Date.now();
  let i = 0;
  const tick = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    err.write(`\r\x1b[K${c.cyan(frames[i++ % frames.length]!)} ${c.dim(`${label} ${s}s`)}`);
  };
  tick();
  const timer = setInterval(tick, 100);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    err.write("\r\x1b[K"); // clear the spinner line before real output lands
  };
}
