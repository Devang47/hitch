import { c } from "../colors.js";
import { fetchCatalog, pickModel, searchModels } from "../config/models.js";
import { setDefaultModel } from "../config/settings.js";
import { config } from "../core/llm.js";
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
  { match: (l) => l === "/", run: () => printCommands() },
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

function printCommands(): void {
  console.log(c.dim("commands (Tab to complete):"));
  for (const [name, desc] of COMMANDS) console.log(`  ${c.cyan(name.padEnd(19))} ${c.dim(desc)}`);
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
