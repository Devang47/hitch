#!/usr/bin/env node
import "./loadenv.js"; // must be first: loads .env before config reads process.env
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { type IO, runTurn } from "./agent.js";
import { loadedContextFiles, systemPrompt } from "./context.js";
import { config } from "./llm.js";
import type { PermMode } from "./permissions.js";
import { appendMessage, latestSession, loadMessages, newSessionPath } from "./session.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    resume: { type: "boolean" },
    yolo: { type: "boolean" },
    readonly: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  printHelp();
  process.exit(0);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY. Get one at https://openrouter.ai/keys");
  process.exit(1);
}

if (values.model) config.model = values.model;
const mode: PermMode = values.yolo ? "yolo" : values.readonly ? "readonly" : "ask";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const io: IO = { out: (s) => process.stdout.write(s), ask: (q) => rl.question(q) };

// Session: resume the latest, or start fresh.
let sessionPath: string;
let messages: any[];
const resumed = values.resume ? latestSession() : undefined;
if (resumed) {
  sessionPath = resumed;
  messages = loadMessages(resumed);
} else {
  sessionPath = newSessionPath();
  messages = [{ role: "system", content: systemPrompt() }];
  appendMessage(sessionPath, messages[0]);
}

const totals: { prompt: number; completion: number; cost: number } = {
  prompt: 0,
  completion: 0,
  cost: 0,
};

header(resumed !== undefined);

// Optional first prompt from the command line.
const initial = positionals.join(" ").trim();
if (initial) await turn(initial);

// One-shot when piped (e.g. `hitch "..." < /dev/null`): don't hang waiting on stdin.
if (initial && !process.stdin.isTTY) {
  rl.close();
  process.exit(0);
}

for (;;) {
  let line: string;
  try {
    line = (await rl.question("\n› ")).trim();
  } catch {
    break; // EOF / Ctrl-D
  }
  if (!line) continue;
  if (line === "/exit" || line === "/quit") break;
  if (line === "/help") {
    printHelp();
    continue;
  }
  if (line === "/cost") {
    console.log(costLine(totals));
    continue;
  }
  if (line.startsWith("/model")) {
    const id = line.slice("/model".length).trim();
    if (id) {
      config.model = id;
      console.log(`model → ${config.model}`);
    } else {
      console.log(`model: ${config.model}`);
    }
    continue;
  }
  await turn(line);
}
rl.close();

async function turn(text: string): Promise<void> {
  const user = { role: "user", content: text };
  messages.push(user);
  appendMessage(sessionPath, user);
  try {
    const u = await runTurn(messages, io, mode, (m) => appendMessage(sessionPath, m));
    totals.prompt += u.prompt;
    totals.completion += u.completion;
    totals.cost += u.cost;
    process.stdout.write(`\n${dim(costLine(totals))}\n`);
  } catch (e: any) {
    console.error(`\n${dim(`error: ${e.message}`)}`);
  }
}

function header(wasResumed: boolean): void {
  const files = loadedContextFiles();
  console.log(dim(`hitch · ${config.model} · mode: ${mode}${wasResumed ? " · resumed" : ""}`));
  console.log(dim(`cwd: ${process.cwd()}`));
  console.log(dim(`context: ${files.length ? files.join(", ") : "none"} · /help for commands`));
}

function costLine(t: { prompt: number; completion: number; cost: number }): string {
  const tokens = `${t.prompt + t.completion} tok (${t.prompt}+${t.completion})`;
  return t.cost > 0 ? `$${t.cost.toFixed(4)} · ${tokens}` : tokens;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function printHelp(): void {
  console.log(`hitch — a minimal OpenRouter coding agent

usage: hitch [prompt] [flags]

flags:
  --model <id>   model to use (default: $HITCH_MODEL or ${config.model})
  --resume       continue the most recent session in this directory
  --yolo         auto-approve every tool call
  --readonly     allow reads only; block writes and commands
  -h, --help     show this help

in-session:
  /model [id]    show or switch the model
  /cost          show token + cost totals
  /help          this help
  /exit          quit`);
}
