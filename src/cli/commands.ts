import { search } from "@inquirer/prompts";
import { c } from "../colors.js";
import { fetchCatalog, pickModel, searchModels } from "../config/models.js";
import {
  removeMcpServer,
  resolveMcpServers,
  setDefaultModel,
  setMcpServer,
} from "../config/settings.js";
import { config } from "../core/llm.js";
import { connectedServers, connectServer, disconnectServer, toolCount } from "../core/mcp.js";
import type { Usage } from "../types.js";
import { costLine, printHelp } from "./ui.js";

/** State a command handler may touch. `pauseInput` yields the readline while an
 *  @inquirer prompt takes over raw-mode stdin. */
export type CommandCtx = {
  totals: Usage;
  pauseInput: <T>(fn: () => Promise<T>) => Promise<T>;
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
      console.log(costLine(ctx.totals));
    },
  },
  {
    match: (l) => l === "/model" || l.startsWith("/model ") || l.startsWith("/models"),
    run: (l, ctx) => handleModel(l, ctx),
  },
  { match: (l) => l === "/mcp" || l.startsWith("/mcp "), run: (l) => handleMcp(l) },
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
