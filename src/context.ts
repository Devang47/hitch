import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREAMBLE =
  "You are hitch, a fast, minimal coding agent working in the user's terminal. " +
  "You help by reading files, running commands, editing code, and writing new files.";

const RULES = [
  "Prefer acting with tools over describing what you would do.",
  "Read a file before you edit it, and match the surrounding code's style.",
  "Use bash for anything the file tools don't cover: search (rg, find), git, tests, running code.",
  "Keep changes minimal and focused on what was asked.",
  "After changing code, verify it when practical (run it, run tests, or type-check).",
  "The user sees your tool calls, so don't narrate them step by step. Be concise.",
  "When the task is done, stop and give a one- or two-line summary.",
]
  .map((r) => `- ${r}`)
  .join("\n");

/** Load an AGENTS.md if it exists, wrapped so the model can attribute it. */
function contextFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return `<project_instructions path="${path}">\n${readFileSync(path, "utf8").trim()}\n</project_instructions>`;
}

/** The full system prompt: preamble + rules + AGENTS.md files + environment. */
export function systemPrompt(cwd = process.cwd()): string {
  const sections = [
    PREAMBLE,
    `<rules>\n${RULES}\n</rules>`,
    contextFile(join(homedir(), ".hitch", "AGENTS.md")),
    contextFile(join(cwd, "AGENTS.md")),
    `<environment>\ncwd: ${cwd}\nos: ${process.platform}\ndate: ${new Date().toISOString().slice(0, 10)}\n</environment>`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** Which AGENTS.md files are in play — for the startup header. */
export function loadedContextFiles(cwd = process.cwd()): string[] {
  return [join(homedir(), ".hitch", "AGENTS.md"), join(cwd, "AGENTS.md")].filter((p) =>
    existsSync(p),
  );
}
