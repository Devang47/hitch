import { basename } from "node:path";
import { c } from "../colors.js";
import type { Usage } from "../types.js";

export const VERSION = "0.2.0"; // kept in step with package.json (guarded by a unit test)

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
  const rows: [string, string][] = [
    ["model", `${c.green(model)}${resumed ? c.yellow("  · resumed") : ""}`],
    ["dir", c.magenta(basename(cwd) || cwd)],
    ["mode", modeColor(mode)],
    ["context", ctx],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return [
    "",
    ...LOGO.map((l) => c.cyan(l)),
    "",
    `  ${c.dim(`a minimal OpenRouter coding agent · v${VERSION}`)}`,
    "",
    ...rows.map(([k, v]) => `  ${c.dim(k.padEnd(w))}   ${v}`),
    "",
    `  ${c.dim("/help for commands · / to browse")}`,
  ].join("\n");
}

function modeColor(mode: string): string {
  if (mode === "yolo") return c.red("yolo");
  if (mode === "readonly") return c.yellow("readonly");
  return c.green("ask");
}

export type PromptInfo = {
  cwd: string;
  model: string;
  mode: string;
  used: number;
  limit: number | undefined;
  cost: number;
};

/** The REPL prompt: a status line (dir · model · mode · context% · cost) above
 *  the input arrow, like a rich shell prompt. Two lines so ANSI colors on the
 *  status can't throw off readline's cursor math on the input line. */
export function promptLabel({ cwd, model, mode, used, limit, cost }: PromptInfo): string {
  const segs = [
    c.green(shortModel(model)),
    modeColor(mode),
    contextPct(used, limit),
    cost > 0 ? c.green(`$${cost.toFixed(4)}`) : "",
  ].filter(Boolean);
  const dir = c.magenta(basename(cwd) || "hitch");
  return `${dir} ${c.dim("│")} ${segs.join(c.dim(" · "))}\n${c.cyan("❯")} `;
}

/** Context fill as a compact percentage ("9% ctx"); empty when the limit is
 *  unknown. Yellow past 80% — the same threshold that triggers auto-trim. */
function contextPct(used: number, limit: number | undefined): string {
  if (!limit) return "";
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (pct >= 80 ? c.yellow : c.dim)(`${pct}% ctx`);
}

/** Model id without its provider prefix: "nvidia/nemotron:free" → "nemotron:free". */
function shortModel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** Set the terminal tab/window title (OSC 0). No-op when stdout is piped so we
 *  never leak escape codes into captured output. `state` (e.g. "thinking")
 *  prefixes the session dir when the agent is busy. */
export function setTitle(cwd: string, state = ""): void {
  if (!process.stdout.isTTY) return;
  const dir = basename(cwd) || "hitch";
  const title = state ? `hitch · ${state} · ${dir}` : `hitch · ${dir}`;
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/** One-line token/cost summary for a turn's running totals. */
export function costLine(t: Usage): string {
  const tok = c.dim(`${t.prompt + t.completion} tok (${t.prompt}+${t.completion})`);
  return t.cost > 0 ? `${c.green(`$${t.cost.toFixed(4)}`)} ${c.dim("·")} ${tok}` : tok;
}

/** Current context estimate vs the model's window, e.g. "12k/128k ctx (9%)".
 *  Empty when the limit is unknown (catalog not fetched); turns yellow near full.
 *  Percent is clamped to 100 (a rough over-estimate shouldn't read past full). */
export function contextLine(used: number, limit: number | undefined): string {
  if (!limit) return "";
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (pct >= 80 ? c.yellow : c.dim)(`${k(used)}/${k(limit)} ctx (${pct}%)`);
}

/** Cost totals with the context indicator appended when known. Shared by the
 *  per-turn footer and `/cost` so the two never drift. */
export function statusLine(t: Usage, used: number, limit: number | undefined): string {
  const ctx = contextLine(used, limit);
  return `${costLine(t)}${ctx ? ` ${c.dim("·")} ${ctx}` : ""}`;
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
  /btw <question>     answer a side question in a parallel process (read-only)
  /compact       summarize older turns to free up context
  /cost          token + cost totals
  /help          this help
  /exit          quit
  ${c.dim("Ctrl-C interrupts the running turn; again at the prompt to quit")}`);
}
