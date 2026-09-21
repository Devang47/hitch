import type { Tool } from "./tools.js";
import { c } from "./ui.js";

export type PermMode = "ask" | "yolo" | "readonly";

// ponytail: single session-wide "approve all" latch. Fine for one interactive
// session; make it per-tool or per-command if that ever proves too coarse.
let approveAll = false;

export type Permission = { ok: true } | { ok: false; reason: string };

export async function checkPermission(
  tool: Tool,
  args: any,
  mode: PermMode,
  ask: (question: string) => Promise<string>,
): Promise<Permission> {
  if (tool.risk === "safe") return { ok: true };
  if (mode === "readonly") return { ok: false, reason: "readonly mode blocks writes and commands" };
  if (mode === "yolo" || approveAll) return { ok: true };

  const detail = args.command ?? args.path ?? "";
  const q = `  ${c.yellow("allow")} ${c.bold(tool.name)} ${c.dim(`\`${detail}\``)} ${c.dim("[y]es / [n]o / [a]ll:")} `;
  const answer = (await ask(q)).trim().toLowerCase();
  if (answer === "a" || answer === "all") {
    approveAll = true;
    return { ok: true };
  }
  if (answer === "y" || answer === "yes") return { ok: true };
  return { ok: false, reason: "denied by user" };
}
