#!/usr/bin/env node
import "../config/loadenv.js"; // must be first: loads .env before config reads process.env
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { c } from "../colors.js";
import { loadedContextFiles, systemPrompt } from "../config/context.js";
import { resolveApiKey, resolveMcpServers, resolveModel } from "../config/settings.js";
import { runTurn } from "../core/agent.js";
import { config } from "../core/llm.js";
import { closeAll, connectAll, connectedServers } from "../core/mcp.js";
import type { PermMode } from "../core/permissions.js";
import { sandboxImage, startSandbox } from "../core/sandbox.js";
import { appendMessage, latestSession, loadMessages, newSessionPath } from "../session/session.js";
import type { IO, Message, Usage } from "../types.js";
import { completer, runCommand } from "./commands.js";
import { onboard } from "./onboard.js";
import { banner, costLine, printHelp, promptLabel, setTitle } from "./ui.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    resume: { type: "boolean" },
    yolo: { type: "boolean" },
    readonly: { type: "boolean" },
    docker: { type: "boolean" },
    btw: { type: "string" }, // internal: answer a /btw fork file, then exit
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  printHelp();
  await flushExit(0);
}

// First run: no key anywhere. Onboard interactively, or fail fast when piped.
if (!resolveApiKey()) {
  if (!process.stdin.isTTY) {
    console.error(
      "Missing OPENROUTER_API_KEY. Set it, or run hitch in a terminal to set up interactively.",
    );
    await flushExit(1);
  }
  await onboard();
}

config.model = resolveModel(values.model); // --model > $HITCH_MODEL > config default > fallback

// Child mode (spawned by /btw): load the forked conversation — its last message
// is the side question — answer it once, read-only so a parallel run can't mutate
// the shared working tree, then exit. The parent captures this stdout.
if (values.btw) {
  const io: IO = { out: (s) => process.stdout.write(s), ask: async () => "n" };
  try {
    await runTurn(loadMessages(values.btw), io, "readonly", () => {});
  } catch (e: any) {
    process.stdout.write(`\n[btw error] ${e?.message ?? e}\n`);
  }
  await flushExit(0);
}

const mode: PermMode = values.yolo ? "yolo" : values.readonly ? "readonly" : "ask";
const cwd = process.cwd();

// --docker: run the bash tool inside a throwaway container (cwd bind-mounted).
if (values.docker) {
  try {
    const id = startSandbox(cwd);
    console.log(c.dim(`sandbox  docker ${sandboxImage()} · ${id.slice(0, 12)}`));
  } catch (e: any) {
    console.error(`${c.red("sandbox failed:")} ${c.dim(e.message ?? String(e))}`);
    console.error(c.dim("  is Docker installed and running? omit --docker to run on the host."));
    await flushExit(1);
  }
}

// MCP: connect configured servers; their tools merge into the live tool set.
// Manage them at runtime with /mcp (add/remove without a restart).
const mcpServers = resolveMcpServers();
if (Object.keys(mcpServers).length) {
  const n = await connectAll(mcpServers);
  console.log(c.dim(`mcp      ${n} tool(s) from ${connectedServers().length} server(s)`));
}

const rl = createInterface({ input: process.stdin, output: process.stdout, completer });
const io: IO = { out: (s) => process.stdout.write(s), ask: (q) => rl.question(q) };

// Stdin exhausted (piped input ends, or Ctrl-D). When an MCP child keeps the
// event loop alive, `rl.question` never settles on an ended stream — so we race
// the prompt against this to break the REPL and clean up instead of hanging.
let onInputClosed: () => void;
const inputClosed = new Promise<void>((res) => {
  onInputClosed = res;
});
rl.once("close", () => onInputClosed());

// Session: resume the latest, or start fresh.
let sessionPath: string;
let messages: Message[];
const resumed = values.resume ? latestSession() : undefined;
if (resumed) {
  sessionPath = resumed;
  messages = loadMessages(resumed);
} else {
  sessionPath = newSessionPath();
  const system: Message = { role: "system", content: systemPrompt() };
  messages = [system];
  appendMessage(sessionPath, system);
}

const totals: Usage = { prompt: 0, completion: 0, cost: 0 };
const ctx = { totals, pauseInput: withRlPaused, messages };

console.log(
  banner({
    model: config.model,
    cwd,
    mode,
    context: loadedContextFiles(),
    resumed: resumed !== undefined,
  }),
);
setTitle(cwd); // name the terminal tab after the session dir

// Optional first prompt from the command line.
const initial = positionals.join(" ").trim();
if (initial) await turn(initial);

// One-shot when piped (e.g. `hitch "..." < /dev/null`): don't hang waiting on stdin.
if (initial && !process.stdin.isTTY) {
  await closeAll();
  rl.close();
  await flushExit(0);
}

for (;;) {
  let line: string | null;
  try {
    line = await Promise.race([
      rl.question(`\n${promptLabel(cwd)}`).then((l) => l.trim()),
      inputClosed.then(() => null),
    ]);
  } catch {
    break; // Ctrl-D on a TTY rejects the pending question
  }
  if (line === null) break; // stdin exhausted (piped input ended)
  if (!line) continue;
  const result = await runCommand(line, ctx);
  if (result === "exit") break;
  if (result === "handled") continue;
  await turn(line);
}
rl.close();
await closeAll();
await flushExit(0);

async function turn(text: string): Promise<void> {
  const user: Message = { role: "user", content: text };
  messages.push(user);
  appendMessage(sessionPath, user);
  io.out("\n"); // gap between the input line and the reply
  setTitle(cwd, "thinking");
  try {
    const u = await runTurn(messages, io, mode, (m) => appendMessage(sessionPath, m));
    totals.prompt += u.prompt;
    totals.completion += u.completion;
    totals.cost += u.cost;
    process.stdout.write(`\n${costLine(totals)}\n`);
  } catch (e: any) {
    const meta = e?.error?.metadata; // OpenRouter puts the real reason here
    const msg = e?.message ?? String(e);
    const via = meta?.provider_name ? c.dim(` · via ${meta.provider_name}`) : "";
    console.error(`\n${c.red("error")} ${c.dim(msg)}${via}`);
    // The provider's own message (e.g. why a :free model 429'd + how to fix it).
    const detail = meta?.raw ?? e?.error?.message;
    if (detail && detail !== msg) console.error(c.dim(`  ${detail}`));
    if (/402|more credits|max_tokens/i.test(msg)) {
      console.error(
        c.dim(
          "  hint: lower HITCH_MAX_TOKENS, switch to a cheaper/free model with /model, or add OpenRouter credit.",
        ),
      );
    }
  } finally {
    setTitle(cwd); // back to idle
  }
}

// @inquirer takes over stdin in raw mode; pause our readline so they don't fight.
async function withRlPaused<T>(fn: () => Promise<T>): Promise<T> {
  rl.pause();
  try {
    return await fn();
  } finally {
    rl.resume();
  }
}

// process.exit() truncates async (piped) stdout/stderr mid-write — on a TTY those
// writes are synchronous, so this only bites the piped e2e under CI load (the
// intermittent failure). Drain both streams first, then exit. Callers `await` it,
// so the following process.exit still halts before any later code runs.
async function flushExit(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    let pending = 2;
    const done = () => {
      if (--pending === 0) resolve();
    };
    process.stdout.write("", done);
    process.stderr.write("", done);
  });
  process.exit(code);
}
