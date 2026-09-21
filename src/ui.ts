import { basename } from "node:path";

// Colors auto-off when not a TTY (pipes, CI) or when NO_COLOR is set — keeps
// piped output and test assertions clean. No dependency: just ANSI.
const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;
const style = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: style("2"),
  bold: style("1"),
  red: style("31"),
  green: style("32"),
  yellow: style("33"),
  magenta: style("35"),
  cyan: style("36"),
};

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
