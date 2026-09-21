// ANSI color helpers. Colors auto-off when not a TTY (pipes, CI) or when NO_COLOR
// is set — keeps piped output and test assertions clean. No dependency: just ANSI.
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
