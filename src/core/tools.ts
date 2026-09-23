import { exec } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { wrapCommand } from "./sandbox.js";

const execAsync = promisify(exec);

/** Keep the OpenRouter key out of tool results (it lives in .env / config.json,
 *  which the model may read or `cat`) so it never enters the transcript or logs.
 *  Matched by its `sk-or-` prefix, so no path/filename allowlist to maintain. */
function redactSecrets(text: string): string {
  return text.replace(/sk-or-[A-Za-z0-9._-]+/g, "sk-or-***redacted***");
}

/** `safe` tools run without asking; `write`/`exec` go through the permission gate. */
export type Risk = "safe" | "write" | "exec";

export type Tool = {
  name: string;
  description: string;
  parameters?: z.ZodType; // built-in tools validate/normalize args with zod
  jsonSchema?: Record<string, unknown>; // MCP tools carry a raw JSON Schema instead
  risk: Risk;
  run: (args: any) => Promise<string>;
};

const read: Tool = {
  name: "read_file",
  description: "Read a file from disk. Returns its contents prefixed with 1-based line numbers.",
  risk: "safe",
  parameters: z.object({
    path: z.string().describe("File path, absolute or relative to the working directory"),
    offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return"),
  }),
  run: async ({ path, offset = 1, limit }) => {
    const text = redactSecrets(readFileSync(resolve(path), "utf8"));
    if (text === "") return "(empty file)";
    const lines = text.split("\n");
    const start = offset - 1;
    if (start >= lines.length)
      return `(offset ${offset} is past end of file — ${lines.length} line(s))`;
    const slice = limit ? lines.slice(start, start + limit) : lines.slice(start);
    return slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n") || "(empty file)";
  },
};

const write: Tool = {
  name: "write_file",
  description: "Create or overwrite a file with the given content. Creates parent directories.",
  risk: "write",
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  run: async ({ path, content }) => {
    const p = resolve(path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return `Wrote ${content.length} bytes to ${path}`;
  },
};

const edit: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must appear exactly once unless replace_all is set. Include surrounding context to make it unique.",
  risk: "write",
  parameters: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  run: async ({ path, old_string, new_string, replace_all }) => {
    const p = resolve(path);
    const text = readFileSync(p, "utf8");
    const count = text.split(old_string).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${path}`);
    if (count > 1 && !replace_all)
      throw new Error(`old_string appears ${count} times; add context or pass replace_all`);
    // `() => new_string` (a function replacer) so `$&`, `$$`, `$1` etc. in the
    // replacement are inserted literally, not treated as regex substitutions.
    const next = replace_all
      ? text.split(old_string).join(new_string)
      : text.replace(old_string, () => new_string);
    writeFileSync(p, next);
    return `Edited ${path} (${replace_all ? count : 1} replacement${replace_all && count > 1 ? "s" : ""})`;
  },
};

const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command in the working directory. Use for search (rg, find), git, tests, running code, and anything the file tools don't cover. Returns combined stdout and stderr.",
  risk: "exec",
  parameters: z.object({
    command: z.string(),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Kill the command after this many ms (default 120000)"),
  }),
  run: async ({ command, timeout_ms = 120_000 }) => {
    try {
      const { stdout, stderr } = await execAsync(wrapCommand(command), {
        timeout: timeout_ms,
        maxBuffer: 10 * 1024 * 1024,
      });
      return (
        redactSecrets(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim()) || "(no output)"
      );
    } catch (e: any) {
      // Non-zero exit or timeout: hand the output back so the model can react.
      const out = `${e.stdout ?? ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}`.trim();
      return redactSecrets(
        `Command failed (exit ${e.code ?? "?"}${e.killed ? ", timed out" : ""}):\n${out || e.message}`,
      );
    }
  },
};

export const tools: Tool[] = [read, write, edit, bash];
export const toolMap = new Map(tools.map((t) => [t.name, t]));

/** Add tools discovered at runtime (e.g. from MCP servers) to the live set. */
export function registerTools(extra: Tool[]): void {
  for (const t of extra) {
    tools.push(t);
    toolMap.set(t.name, t);
  }
}

/** Remove previously-registered tools by name (e.g. on MCP disconnect). */
export function unregisterTools(names: string[]): void {
  const drop = new Set(names);
  for (let i = tools.length - 1; i >= 0; i--) {
    if (drop.has(tools[i]!.name)) tools.splice(i, 1);
  }
  for (const n of names) toolMap.delete(n);
}

/** OpenAI/OpenRouter tool specs: raw JSON schema (MCP) or derived from zod (built-ins). */
export function toolSpecs() {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.jsonSchema ?? z.toJSONSchema(t.parameters as z.ZodType)) as Record<
        string,
        unknown
      >,
    },
  }));
}
