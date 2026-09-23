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
  // pid disambiguates two hitch processes started in the same millisecond in a
  // shared working tree — otherwise both append to one file and corrupt it.
  return join(DIR, `${Date.now()}-${process.pid}.jsonl`);
}

export function appendMessage(path: string, message: Message): void {
  appendFileSync(path, `${JSON.stringify(message)}\n`);
}

export function loadMessages(path: string): Message[] {
  if (!existsSync(path)) return [];
  const messages = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    // A crash/Ctrl-C mid-write can leave a truncated final line; skip anything
    // that won't parse rather than aborting the whole resume.
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Message];
      } catch {
        return [];
      }
    });
  return repairTail(messages);
}

/** A session killed mid-turn can end with an assistant `tool_calls` message
 *  whose tool results were never written (or only some were). Sending that to
 *  the API 400s, so drop the last unanswered tool_calls message and everything
 *  after it, back to a valid boundary. */
function repairTail(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set(
      messages
        .slice(i + 1)
        .filter((x) => x.role === "tool")
        .map((x) => x.tool_call_id),
    );
    // Fully answered → the tail is valid; leave it. Otherwise truncate from here.
    return m.tool_calls.every((tc) => answered.has(tc.id)) ? messages : messages.slice(0, i);
  }
  return messages;
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
