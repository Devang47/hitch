#!/usr/bin/env node
import "./loadenv.js"; // must be first: loads .env before config reads process.env
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { confirm, password } from "@inquirer/prompts";
import { type IO, runTurn } from "./agent.js";
import { loadedContextFiles, systemPrompt } from "./context.js";
import { config } from "./llm.js";
import { fetchCatalog, pickModel, searchModels } from "./models.js";
import type { PermMode } from "./permissions.js";
import { appendMessage, latestSession, loadMessages, newSessionPath } from "./session.js";
import { configFile, resolveApiKey, resolveModel, setApiKey, setDefaultModel } from "./settings.js";

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

// First run: no key anywhere. Onboard interactively, or fail fast when piped.
if (!resolveApiKey()) {
  if (!process.stdin.isTTY) {
    console.error(
      "Missing OPENROUTER_API_KEY. Set it, or run hitch in a terminal to set up interactively.",
    );
    process.exit(1);
  }
  await onboard();
}

config.model = resolveModel(values.model); // --model > $HITCH_MODEL > config default > fallback
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
  if (line === "/model" || line.startsWith("/model ") || line.startsWith("/models")) {
    try {
      await handleModelCommand(line);
    } catch (e: any) {
      console.error(dim(`model command failed: ${e.message}`));
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

async function handleModelCommand(line: string): Promise<void> {
  if (line === "/models --refresh") {
    process.stdout.write("refreshing model list… ");
    console.log(`${(await fetchCatalog(true)).length} models`);
    return;
  }
  if (line === "/models --default") {
    const id = await withRlPaused(() => pickModel());
    if (id) {
      setDefaultModel(id);
      config.model = id;
      console.log(`default model → ${id} (all new sessions + this one)`);
    }
    return;
  }
  // `/model [query]` (or bare `/models`) → pick for THIS session only.
  const query = line.startsWith("/model ") ? line.slice(7).trim() : "";
  let id: string | undefined;
  if (query) {
    const matches = searchModels(await fetchCatalog(), query);
    if (matches.length === 1) id = matches[0]?.id;
  }
  if (!id) id = await withRlPaused(() => pickModel());
  if (id) {
    config.model = id;
    console.log(`model → ${id} (this session)`);
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

async function onboard(): Promise<void> {
  console.log("Welcome to hitch — let's set up.\n");
  const key = (
    await password({ message: "OpenRouter API key (https://openrouter.ai/keys):", mask: "*" })
  ).trim();
  if (!key) {
    console.error("No key entered. Exiting.");
    process.exit(1);
  }
  setApiKey(key);
  if (
    await confirm({
      message: `Pick a default model now? (otherwise ${resolveModel()})`,
      default: true,
    })
  ) {
    const id = await pickModel();
    if (id) {
      setDefaultModel(id);
      console.log(`default model → ${id}`);
    }
  }
  console.log(`Saved to ${configFile()}\n`);
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
  --model <id>   model for this run (default: config default, or $HITCH_MODEL)
  --resume       continue the most recent session in this directory
  --yolo         auto-approve every tool call
  --readonly     allow reads only; block writes and commands
  -h, --help     show this help

in-session:
  /model [query]      pick the model for THIS session (searchable)
  /models --default   set the default model for all new sessions
  /models --refresh   refresh the model list from OpenRouter
  /cost               token + cost totals
  /help               this help
  /exit               quit`);
}
