#!/usr/bin/env node
import "../config/loadenv.js"; // must be first: loads .env before config reads process.env
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { c } from "../colors.js";
import { loadedContextFiles, systemPrompt } from "../config/context.js";
import { resolveApiKey, resolveModel } from "../config/settings.js";
import { runTurn } from "../core/agent.js";
import { config } from "../core/llm.js";
import type { PermMode } from "../core/permissions.js";
import { appendMessage, latestSession, loadMessages, newSessionPath } from "../session/session.js";
import type { IO, Message, Usage } from "../types.js";
import { completer, runCommand } from "./commands.js";
import { onboard } from "./onboard.js";
import { banner, costLine, printHelp, promptLabel } from "./ui.js";

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
const cwd = process.cwd();

const rl = createInterface({ input: process.stdin, output: process.stdout, completer });
const io: IO = { out: (s) => process.stdout.write(s), ask: (q) => rl.question(q) };

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
const ctx = { totals, pauseInput: withRlPaused };

console.log(
  banner({
    model: config.model,
    cwd,
    mode,
    context: loadedContextFiles(),
    resumed: resumed !== undefined,
  }),
);

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
    line = (await rl.question(`\n${promptLabel(cwd)}`)).trim();
  } catch {
    break; // EOF / Ctrl-D
  }
  if (!line) continue;
  const result = await runCommand(line, ctx);
  if (result === "exit") break;
  if (result === "handled") continue;
  await turn(line);
}
rl.close();

async function turn(text: string): Promise<void> {
  const user: Message = { role: "user", content: text };
  messages.push(user);
  appendMessage(sessionPath, user);
  try {
    const u = await runTurn(messages, io, mode, (m) => appendMessage(sessionPath, m));
    totals.prompt += u.prompt;
    totals.completion += u.completion;
    totals.cost += u.cost;
    process.stdout.write(`\n${costLine(totals)}\n`);
  } catch (e: any) {
    const msg = e.message ?? String(e);
    console.error(`\n${c.red("error")} ${c.dim(msg)}`);
    if (/402|more credits|max_tokens/i.test(msg)) {
      console.error(
        c.dim(
          "  hint: lower HITCH_MAX_TOKENS, switch to a cheaper/free model with /model, or add OpenRouter credit.",
        ),
      );
    }
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
