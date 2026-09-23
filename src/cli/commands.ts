import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search } from "@inquirer/prompts";
import { c } from "../colors.js";
import { cachedContextLimit, fetchCatalog, pickModel, searchModels } from "../config/models.js";
import {
  removeMcpServer,
  resolveMcpServers,
  setDefaultModel,
  setMcpServer,
} from "../config/settings.js";
import { compact, estimateTokens } from "../core/compaction.js";
import { client, config } from "../core/llm.js";
import { connectedServers, connectServer, disconnectServer, toolCount } from "../core/mcp.js";
import { appendMessage } from "../session/session.js";
import type { Message, Usage } from "../types.js";
import { contextLine, costLine, printHelp } from "./ui.js";

/** State a command handler may touch. `pauseInput` yields the readline while an
 *  @inquirer prompt takes over raw-mode stdin. */
export type CommandCtx = {
  totals: Usage;
  pauseInput: <T>(fn: () => Promise<T>) => Promise<T>;
  messages: Message[]; // the live conversation — /btw forks a snapshot of it
};

// Catalog for tab-completion and the `/` list. Add a command: one row here + a
// handler below. Kept together so extending the REPL is a two-line change.
const COMMANDS: [string, string][] = [
  ["/model", "pick the model for this session"],
  ["/models --default", "set the default model for all new sessions"],
  ["/models --refresh", "refresh the model list from OpenRouter"],
  ["/mcp", "list MCP servers and their tools"],
  ["/mcp add", "connect + save a server: /mcp add <name> <command> [args...]"],
  ["/mcp remove", "disconnect + forget a server: /mcp remove <name>"],
  ["/btw", "answer a side question in a parallel process: /btw <question>"],
  ["/compact", "summarize older turns to free up context"],
  ["/cost", "token + cost totals"],
  ["/help", "show help"],
  ["/exit", "quit"],
];

// A handler returns the sentinel "exit" to quit the REPL; any other value is ignored.
type Handler = {
  match: (line: string) => boolean;
  run: (line: string, ctx: CommandCtx) => unknown;
};

const handlers: Handler[] = [
  {
    match: (l) => l === "/",
    run: async (_l, ctx) => {
      const picked = await ctx.pauseInput(pickCommand);
      return picked ? runCommand(picked, ctx) : undefined; // dispatch choice (may "exit")
    },
  },
  { match: (l) => l === "/help", run: () => printHelp() },
  {
    match: (l) => l === "/cost",
    run: (_l, ctx) => {
      const ctxLine = contextLine(estimateTokens(ctx.messages), cachedContextLimit(config.model));
      console.log(`${costLine(ctx.totals)}${ctxLine ? ` ${c.dim("·")} ${ctxLine}` : ""}`);
    },
  },
  {
    match: (l) => l === "/model" || l.startsWith("/model ") || l.startsWith("/models"),
    run: (l, ctx) => handleModel(l, ctx),
  },
  { match: (l) => l === "/mcp" || l.startsWith("/mcp "), run: (l) => handleMcp(l) },
  {
    match: (l) => l === "/btw" || l.startsWith("/btw "),
    run: (l, ctx) => handleBtw(l.slice(4).trim(), ctx.messages),
  },
  { match: (l) => l === "/compact", run: (_l, ctx) => handleCompact(ctx.messages) },
  { match: (l) => l === "/exit" || l === "/quit", run: () => "exit" },
];

/** Dispatch one input line. "pass" = not a slash command; send it to the model. */
export async function runCommand(
  line: string,
  ctx: CommandCtx,
): Promise<"exit" | "handled" | "pass"> {
  if (!line.startsWith("/")) return "pass";
  const handler = handlers.find((h) => h.match(line));
  if (!handler) {
    console.log(c.dim(`unknown command: ${line} — type / for a list`));
    return "handled";
  }
  try {
    return (await handler.run(line, ctx)) === "exit" ? "exit" : "handled";
  } catch (e: any) {
    console.error(`${c.red("command failed:")} ${c.dim(e.message ?? String(e))}`);
    return "handled";
  }
}

/** readline completer: complete slash commands (and list them on a bare "/"). */
export function completer(line: string): [string[], string] {
  const names = COMMANDS.map(([n]) => n);
  if (!line.startsWith("/")) return [[], line];
  const hits = names.filter((n) => n.startsWith(line));
  return [hits.length ? hits : names, line];
}

/** Live filter-as-you-type dropdown over COMMANDS. Returns the chosen command
 *  line, or undefined if cancelled (Ctrl-C / Esc). */
async function pickCommand(): Promise<string | undefined> {
  try {
    return await search({
      message: "command (type to filter)",
      source: (term) => {
        const q = (term ?? "").toLowerCase();
        return COMMANDS.filter(([n, d]) => `${n} ${d}`.toLowerCase().includes(q)).map(
          ([name, desc]) => ({ name, value: name, description: desc }),
        );
      },
    });
  } catch {
    return undefined;
  }
}

async function handleModel(line: string, ctx: CommandCtx): Promise<void> {
  if (line === "/models --refresh") {
    process.stdout.write(c.dim("refreshing model list… "));
    console.log(c.dim(`${(await fetchCatalog(true)).length} models`));
    return;
  }
  if (line === "/models --default") {
    const id = await ctx.pauseInput(() => pickModel());
    if (id) {
      setDefaultModel(id);
      config.model = id;
      console.log(
        `${c.green("default model →")} ${c.bold(id)} ${c.dim("(all new sessions + this one)")}`,
      );
    }
    return;
  }
  // `/model [query]` (or bare `/models`) → pick for THIS session only.
  const query = line.startsWith("/model ") ? line.slice(7).trim() : "";
  let id: string | undefined;
  if (query) {
    const matches = searchModels(await fetchCatalog(), query);
    if (matches.length === 1) id = matches[0]?.id;
  }
  if (!id) id = await ctx.pauseInput(() => pickModel());
  if (id) {
    config.model = id;
    console.log(`${c.green("model →")} ${c.bold(id)} ${c.dim("(this session)")}`);
  }
}

/** `/mcp` (list), `/mcp add <name> <command> [args...]`, `/mcp remove <name>`.
 *  ponytail: naive whitespace split — args with spaces (rare for a server
 *  command) aren't supported; edit config.json directly for those. */
async function handleMcp(line: string): Promise<void> {
  const [sub, ...rest] = line.split(/\s+/).slice(1);
  if (!sub) return listMcp();
  if (sub === "add") return addMcp(rest);
  if (sub === "remove" || sub === "rm") return removeMcp(rest[0]);
  console.log(c.dim("usage: /mcp | /mcp add <name> <command> [args...] | /mcp remove <name>"));
}

function listMcp(): void {
  const configured = resolveMcpServers();
  const live = new Set(connectedServers());
  const names = [...new Set([...Object.keys(configured), ...live])];
  if (!names.length) {
    console.log(c.dim("no MCP servers — add one with /mcp add <name> <command> [args...]"));
    return;
  }
  for (const name of names) {
    const spec = configured[name];
    const on = live.has(name);
    const status = on
      ? `${c.green("●")} ${c.dim(`${toolCount(name)} tools`)}`
      : `${c.dim("○ off")}`;
    const cmd = spec ? c.dim(`${spec.command} ${(spec.args ?? []).join(" ")}`.trim()) : "";
    console.log(`  ${status}  ${c.bold(name)}  ${cmd}`);
  }
}

async function addMcp(parts: string[]): Promise<void> {
  const [name, command, ...args] = parts;
  if (!name || !command) {
    console.log(c.dim("usage: /mcp add <name> <command> [args...]"));
    return;
  }
  const server = args.length ? { command, args } : { command };
  process.stdout.write(c.dim(`connecting ${name}… `));
  try {
    const n = await connectServer(name, server); // connect first; only save if it works
    setMcpServer(name, server);
    console.log(`${c.green("✓")} ${c.bold(name)} ${c.dim(`(${n} tools, saved)`)}`);
  } catch (e: any) {
    console.log(`${c.red("✗")} ${c.dim(e.message ?? String(e))}`);
  }
}

async function removeMcp(name?: string): Promise<void> {
  if (!name) {
    console.log(c.dim("usage: /mcp remove <name>"));
    return;
  }
  const wasLive = await disconnectServer(name);
  const wasSaved = removeMcpServer(name);
  if (!wasLive && !wasSaved) {
    console.log(c.dim(`no such server: ${name}`));
    return;
  }
  console.log(`${c.green("removed")} ${c.bold(name)}${wasLive ? c.dim(" (disconnected)") : ""}`);
}

/** `/btw <question>`: fork the conversation to a temp file, append the question,
 *  and spawn a parallel hitch process (`--btw`) to answer it read-only — the main
 *  agent keeps going and the answer prints when the child finishes.
 *  ponytail: fire-and-forget child; if the parent exits first the child dies on a
 *  closed pipe. Track + kill children only if that ever proves to matter. */
async function handleBtw(question: string, messages: Message[]): Promise<void> {
  if (!question) {
    console.log(c.dim("usage: /btw <question> — answers a side question in a parallel process"));
    return;
  }
  const file = join(tmpdir(), `hitch-btw-${process.pid}-${Date.now()}.jsonl`);
  for (const m of messages) appendMessage(file, m); // snapshot of the chat so far
  appendMessage(file, { role: "user", content: question });

  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] as string, "--btw", file],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  child.on("error", (e) => console.log(`\n${c.red("btw failed:")} ${c.dim(e.message)}`));
  child.on("close", () => {
    rmSync(file, { force: true });
    const body = (out.trim() || "(no answer)")
      .split("\n")
      .map((l) => `${c.magenta("┊")} ${l}`)
      .join("\n");
    console.log(`\n${c.magenta("┊ btw:")} ${c.dim(question)}\n${body}`);
  });
  console.log(
    c.dim(
      `↗ btw running in a parallel process (pid ${child.pid}) — keep working; answer appears when ready.`,
    ),
  );
}

/** `/compact`: summarize the older turns (via the model) into one message so a
 *  long session keeps fitting the context window. In-memory only — the session
 *  file keeps the full log, so --resume reloads everything. */
async function handleCompact(messages: Message[]): Promise<void> {
  const before = estimateTokens(messages);
  process.stdout.write(c.dim("compacting… "));
  try {
    const { summarized } = await compact(messages, 4, summarizeTranscript);
    if (!summarized) {
      console.log(c.dim("nothing to gain from compacting yet — not enough old context"));
      return;
    }
    console.log(
      `${c.green("compacted")} ${summarized} msg(s) ${c.dim(`· ~${before} → ${estimateTokens(messages)} est. tokens`)}`,
    );
  } catch (e: any) {
    console.log(`${c.red("compact failed:")} ${c.dim(e.message ?? String(e))}`);
  }
}

async function summarizeTranscript(transcript: string): Promise<string> {
  const res: any = await client().chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      {
        role: "system",
        content:
          "Summarize this coding-session transcript. Preserve decisions made, file paths, key code, and unfinished tasks. Be concise; output only the summary.",
      },
      { role: "user", content: transcript },
    ],
  } as any);
  return res.choices?.[0]?.message?.content ?? "(summary unavailable)";
}
