import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.js";

// ponytail: flat JSONL log per session, no branching tree (pi has one). Resume
// replays the whole file. Add a tree if branch/rewind ever becomes a real need.
const DIR = join(process.cwd(), ".hitch", "sessions");

export function newSessionPath(): string {
  mkdirSync(DIR, { recursive: true });
  return join(DIR, `${Date.now()}.jsonl`);
}

export function appendMessage(path: string, message: Message): void {
  appendFileSync(path, `${JSON.stringify(message)}\n`);
}

export function loadMessages(path: string): Message[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

/** Most recently modified session file in this directory, if any. */
export function latestSession(): string | undefined {
  if (!existsSync(DIR)) return undefined;
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(DIR, f));
  if (files.length === 0) return undefined;
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
