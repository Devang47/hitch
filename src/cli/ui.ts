import { basename } from "node:path";
import { c } from "../colors.js";
import type { Usage } from "../types.js";

const VERSION = "0.1.0"; // keep in step with package.json

const LOGO = [
  " _     _ _       _     ",
  "| |__ (_) |_ ___| |__  ",
  "| '_ \\| | __/ __| '_ \\ ",
  "| | | | | || (__| | | |",
  "|_| |_|_|\\__\\___|_| |_|",
];

export type BannerInfo = {
  model: string;
  cwd: string;
  mode: string;
  context: string[];
  resumed: boolean;
};

/** Full logo + status on a real terminal; a compact one-liner header when piped. */
export function banner({ model, cwd, mode, context, resumed }: BannerInfo): string {
  if (!process.stdout.isTTY) {
    const ctx = context.length ? context.join(", ") : "none";
    return [
      `hitch · ${model} · mode: ${mode}${resumed ? " · resumed" : ""}`,
      `cwd: ${cwd}`,
      `context: ${ctx} · /help for commands`,
    ].join("\n");
  }
  const ctx = context.length ? context.map((p) => basename(p)).join(", ") : c.dim("none");
  return [
    "",
    ...LOGO.map((l) => c.cyan(l)),
    "",
    `  ${c.dim("a minimal OpenRouter coding agent")} ${c.dim(`· v${VERSION}`)}`,
    "",
    `  ${c.dim("model  ")}  ${c.green(model)}${resumed ? c.yellow("  · resumed") : ""}`,
    `  ${c.dim("dir    ")}  ${c.magenta(basename(cwd) || cwd)}`,
    `  ${c.dim("mode   ")}  ${modeColor(mode)}`,
    `  ${c.dim("context")}  ${ctx}`,
    `  ${c.dim("type /help, or / for commands")}`,
  ].join("\n");
}

function modeColor(mode: string): string {
  if (mode === "yolo") return c.red("yolo");
  if (mode === "readonly") return c.yellow("readonly");
  return c.green("ask");
}

/** The REPL prompt: the current directory name + an arrow. */
export function promptLabel(cwd: string): string {
  return `${c.magenta(basename(cwd) || "hitch")} ${c.cyan("❯")} `;
}

/** One-line token/cost summary for a turn's running totals. */
export function costLine(t: Usage): string {
  const tok = c.dim(`${t.prompt + t.completion} tok (${t.prompt}+${t.completion})`);
  return t.cost > 0 ? `${c.green(`$${t.cost.toFixed(4)}`)} ${c.dim("·")} ${tok}` : tok;
}

export function printHelp(): void {
  console.log(`${c.bold("hitch")} — a minimal OpenRouter coding agent

${c.dim("usage:")} hitch [prompt] [flags]

${c.dim("flags:")}
  --model <id>   model for this run (default: config default, or $HITCH_MODEL)
  --resume       continue the most recent session in this directory
  --yolo         auto-approve every tool call
  --readonly     allow reads only; block writes and commands
  --docker       run the bash tool inside a throwaway container ($HITCH_DOCKER_IMAGE)
  -h, --help     show this help

${c.dim("config:")} ~/.hitch/config.json → fallbackModels[], mcpServers{} ${c.dim("·")} env HITCH_FALLBACK_MODELS

${c.dim("in-session:")}
  /              list commands (Tab completes them)
  /model [query] pick the model for THIS session (searchable)
  /models --default   set the default model for all new sessions
  /models --refresh   refresh the model list from OpenRouter
  /mcp [add|remove]   list or manage MCP servers (connects live, no restart)
  /cost          token + cost totals
  /help          this help
  /exit          quit`);
}
