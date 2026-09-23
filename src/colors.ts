// ANSI color helpers. Colors auto-off when not a TTY (pipes, CI) or when NO_COLOR
// is set — keeps piped output and test assertions clean. No dependency: just ANSI.
const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;
const style = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: style("2"),
  // ~60% opacity: white blended 60% over a dark bg = rgb(153,153,153). A fixed
  // grey since terminals have no real opacity; tweak the RGB for a lighter/darker feel.
  faint: style("38;2;153;153;153"),
  bold: style("1"),
  italic: style("3"),
  underline: style("4"),
  strike: style("9"),
  red: style("31"),
  green: style("32"),
  yellow: style("33"),
  magenta: style("35"),
  cyan: style("36"),
};
