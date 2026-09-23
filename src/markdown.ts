import { c } from "./colors.js";

// Minimal markdown → ANSI, for showing assistant messages in the terminal as
// something other than raw markup. Handles what an LLM actually emits: headings,
// lists, blockquotes, fenced code, GFM tables, rules, and inline bold/italic/
// code/strike/links. Not a spec-complete parser — a pragmatic renderer.
// ponytail: hand-rolled, no marked/marked-terminal dependency; add a block
// handler if some construct ever shows up unrendered.

// Built at runtime so the ESC (0x1b) isn't a literal control char in the source.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visLen = (s: string): number => s.replace(ANSI, "").length;

/** Inline spans. Split on inline `code` first and format only the non-code
 *  segments, so ** / * / _ inside code stay literal — no placeholder juggling. */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`")
        ? c.cyan(part.slice(1, -1))
        : part
            .replace(
              /!?\[([^\]]+)\]\(([^)]+)\)/g,
              (_, t, u) => `${c.underline(c.cyan(t))}${c.dim(` (${u})`)}`,
            )
            .replace(/\*\*([^*]+)\*\*/g, (_, x) => c.bold(x))
            .replace(/~~([^~]+)~~/g, (_, x) => c.strike(x))
            .replace(/(^|[^*\\])\*([^*\n]+)\*/g, (_, p, x) => `${p}${c.italic(x)}`)
            .replace(/(^|[^_\w])_([^_\n]+)_/g, (_, p, x) => `${p}${c.italic(x)}`),
    )
    .join("");
}

const splitRow = (row: string): string[] => {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((x) => x.trim());
};

/** A separator row like `|---|:--:|` — the marker of a GFM table's second line. */
const isTableSep = (l: string): boolean => l.includes("-") && /^[\s|:-]+$/.test(l.trim());

function renderTable(rows: string[], sep: string): string {
  const aligns = splitRow(sep).map((s) =>
    s.startsWith(":") && s.endsWith(":") ? "c" : s.endsWith(":") ? "r" : "l",
  );
  const grid = rows.map((r, ri) =>
    splitRow(r).map((cell) => (ri === 0 ? c.bold(inline(cell)) : inline(cell))),
  );
  const cols = Math.max(...grid.map((g) => g.length));
  const width = Array.from({ length: cols }, (_, ci) =>
    Math.max(1, ...grid.map((g) => visLen(g[ci] ?? ""))),
  );
  const pad = (cell: string, ci: number): string => {
    const gap = width[ci]! - visLen(cell);
    const a = aligns[ci] ?? "l";
    if (a === "r") return " ".repeat(gap) + cell;
    if (a === "c") return " ".repeat(gap >> 1) + cell + " ".repeat(gap - (gap >> 1));
    return cell + " ".repeat(gap);
  };
  const line = (g: string[]) =>
    c.dim("│") +
    Array.from({ length: cols }, (_, ci) => ` ${pad(g[ci] ?? "", ci)} `).join(c.dim("│")) +
    c.dim("│");
  const rule = (l: string, m: string, r: string) =>
    c.dim(l + width.map((w) => "─".repeat(w + 2)).join(m) + r);
  return [
    rule("┌", "┬", "┐"),
    line(grid[0]!),
    rule("├", "┼", "┤"),
    ...grid.slice(1).map(line),
    rule("└", "┴", "┘"),
  ].join("\n");
}

function renderHeading(level: number, text: string): string {
  const t = inline(text);
  return level <= 2 ? c.bold(c.cyan(t)) : c.bold(t);
}

/** Render markdown to an ANSI string for terminal display. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or EOF)
      out.push(body.map((l) => `${c.dim("│")} ${l}`).join("\n"));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const rows = [line];
      const sep = lines[i + 1]!;
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "")
        rows.push(lines[i++]!);
      out.push(renderTable(rows, sep));
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(renderHeading(h[1]!.length, h[2]!));
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(c.dim("─".repeat(48)));
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      out.push(`${c.dim("│")} ${c.dim(inline(line.replace(/^\s*>\s?/, "")))}`);
      i++;
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const marker = /\d/.test(li[2]!) ? c.cyan(li[2]!) : c.cyan("•");
      out.push(`${li[1]}${marker} ${inline(li[3]!)}`);
      i++;
      continue;
    }

    out.push(line.trim() === "" ? "" : inline(line));
    i++;
  }
  return out.join("\n");
}
