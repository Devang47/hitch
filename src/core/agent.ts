import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../colors.js";
import { renderMarkdown } from "../markdown.js";
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
  signal?: AbortSignal,
): Promise<Usage> {
  const usage: Usage = { prompt: 0, completion: 0, cost: 0 };
  const specs = toolSpecs();

  let first = true;
  for (;;) {
    if (signal?.aborted) return usage; // interrupted between loop iterations
    // Fallback chain: [primary, ...fallbacks] as OpenRouter's `models` param.
    // Undefined (no fallbacks) is dropped from the body, leaving plain `model`.
    const models = config.fallbacks.length ? [config.model, ...config.fallbacks] : undefined;

    let content = "";
    const toolCalls: ToolCall[] = [];

    // A blank line before each "thinking" so it isn't cramped against the prompt
    // or a previous tool's output (the first turn's gap comes from the caller).
    if (!first) io.out("\n");
    first = false;
    // Spinner covers the wait for the first token (and any connect/HTTP error);
    // cleared the instant output starts so it never interleaves with the reply.
    const stopSpinner = startSpinner("thinking");
    try {
      // `usage: { include: true }` is an OpenRouter extension (per-request cost in
      // `usage.cost`) that isn't in the OpenAI types, so the params are cast.
      // `signal` lets Ctrl-C abort the in-flight request mid-stream.
      const stream = (await client().chat.completions.create(
        {
          model: config.model,
          models, // OpenRouter fallback chain; dropped when undefined
          messages: withCaching(messages, config.model),
          tools: specs,
          max_tokens: config.maxTokens,
          provider: config.provider, // OpenRouter routing; dropped from the body when undefined
          stream: true,
          stream_options: { include_usage: true },
          usage: { include: true },
        } as any,
        { signal },
      )) as unknown as AsyncIterable<any>;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        // Buffer text (don't stream raw) so we can render it as markdown once the
        // message is whole — a table/heading/bold span can't be rendered mid-token.
        // The spinner keeps turning until the message lands (stopped in `finally`).
        if (delta?.content) content += delta.content;
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
    } catch (e: any) {
      stopSpinner();
      // Ctrl-C / abort: close the turn with whatever text streamed (no tool calls,
      // so the message list stays valid) and hand control back to the REPL.
      if (signal?.aborted || e?.name === "APIUserAbortError" || e?.name === "AbortError") {
        if (content) io.out(`${renderMarkdown(content)}\n`);
        io.out(`${c.yellow("⨯ interrupted")}\n`);
        const partial: Message = { role: "assistant", content: content || "[interrupted]" };
        messages.push(partial);
        onMessage(partial);
        return usage;
      }
      throw e;
    } finally {
      stopSpinner(); // idempotent: also clears on error / empty stream
    }
    // No leading blank: the reply lands on the cleared spinner line, so the only
    // gap is the one placed before "thinking" above (avoids a double blank).
    if (content) io.out(`${renderMarkdown(content)}\n`);

    // Densify holes (a provider streaming non-contiguous indices leaves gaps that
    // `for..of` would yield as undefined) and backfill an id for any call whose
    // fragments never carried one — otherwise the assistant/tool pairing sent on
    // the next request is invalid.
    const calls = toolCalls.filter(Boolean);
    calls.forEach((call, i) => {
      if (!call.id) call.id = `call_${i}`;
    });

    const assistant: Message = { role: "assistant", content: content || null };
    if (calls.length) assistant.tool_calls = calls;
    messages.push(assistant);
    onMessage(assistant);

    if (calls.length === 0) return usage; // model is done for this turn

    for (const call of calls) {
      // Once interrupted, stop running tools but still answer each pending call
      // with a stub so every tool_call keeps its matching tool result.
      const result = signal?.aborted ? "[interrupted]" : await runTool(call, io, mode);
      const toolMessage: Message = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      onMessage(toolMessage);
    }
    if (signal?.aborted) {
      io.out(`${c.yellow("⨯ interrupted")}\n`);
      return usage;
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

  // Action line: a colored tool "chip" + the command/path in bold, so a tool
  // call reads distinctly from the agent's prose above and its output below.
  io.out(`\n  ${c.cyan("⚙")} ${c.bold(c.cyan(tool.name))} ${c.bold(preview(args))}\n`);
  // Readonly rejects every write/edit, so don't bother rendering its diff.
  if (mode !== "readonly") {
    const change = changePreview(tool.name, args);
    if (change) io.out(`${change}\n`);
  }
  const permission = await checkPermission(tool, args, mode, io.ask);
  if (!permission.ok) return `Tool call rejected: ${permission.reason}`;

  try {
    // Built-ins validate/normalize with zod; MCP tools carry no zod schema, so
    // pass their args straight through (the server validates its own input).
    const result = await tool.run(tool.parameters ? tool.parameters.parse(args) : args);
    io.out(toolOutput(result)); // dim gutter marks this as terminal output, not prose
    return result;
  } catch (e: any) {
    const message = `Error: ${e.message}`;
    io.out(`  ${c.red("│")} ${c.red(message)}\n`);
    return message;
  }
}

/** Command/tool output shown under the action line: a dim left gutter on every
 *  line so it reads as terminal output distinct from the agent's prose, capped
 *  to a few lines by default (the full result still goes back to the model). */
function toolOutput(result: string): string {
  const CAP = 5; // show a short preview by default; the full result still goes to the model
  const lines = result.split("\n");
  const shown = lines.slice(0, CAP).map((l) => `  ${c.faint("│")} ${c.faint(l)}`);
  if (lines.length > CAP) shown.push(`  ${c.faint(`│ … +${lines.length - CAP} more lines`)}`);
  return `${shown.join("\n")}\n`;
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

/** A colored preview of a pending file change, shown before the permission
 *  prompt so the user sees exactly what a write/edit will do. edit_file already
 *  carries the exact before/after strings (no diff algorithm needed); write_file
 *  shows the new content and whether it overwrites an existing file. */
export function changePreview(name: string, args: any): string {
  const CAP = 40; // don't flood the terminal on a huge change
  const hunk = (text: string, sign: string, paint: (s: string) => string): string => {
    const lines = String(text).split("\n");
    const out = lines.slice(0, CAP).map((l) => paint(`  ${sign} ${l}`));
    if (lines.length > CAP) out.push(c.dim(`  … (+${lines.length - CAP} more lines)`));
    return out.join("\n");
  };
  if (name === "edit_file") {
    return `${hunk(args.old_string ?? "", "-", c.red)}\n${hunk(args.new_string ?? "", "+", c.green)}`;
  }
  if (name === "write_file") {
    const path = String(args.path ?? "");
    const label = path && existsSync(resolve(path)) ? "overwrite" : "new file";
    return `${c.dim(`  ${label}`)}\n${hunk(args.content ?? "", "+", c.green)}`;
  }
  return "";
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
    err.write(`\r\x1b[K  ${c.cyan(frames[i++ % frames.length]!)} ${c.bold(label)}${c.dim(` ${s}s`)}`);
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
