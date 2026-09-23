import type { Message } from "../types.js";

// Keeping a long session under the model's context window. Two strategies share
// one notion of a "round" (a user message + the assistant/tool messages it
// triggers, up to the next user message) so neither ever splits a tool_call from
// its tool result — which the API rejects.

/** Rough token estimate: ~4 chars/token + a little per-message overhead. Good
 *  enough to keep requests under a window without shipping a tokenizer. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    for (const tc of m.tool_calls ?? []) {
      chars += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return Math.ceil(chars / 4) + messages.length * 4;
}

/** Split into the leading system message (if any) + rounds keyed on user turns. */
function splitRounds(messages: Message[]): { system: Message[]; rounds: Message[][] } {
  const system = messages[0]?.role === "system" ? [messages[0]!] : [];
  const rounds: Message[][] = [];
  for (const m of messages.slice(system.length)) {
    if (m.role === "user" || rounds.length === 0) rounds.push([m]);
    else rounds[rounds.length - 1]!.push(m);
  }
  return { system, rounds };
}

/** Drop whole oldest rounds (keeping the system prompt + newest rounds) until the
 *  estimate fits `limit`. Mutates `messages` in place; returns the count dropped.
 *  Fast and lossy — /compact summarizes instead. */
export function guardContext(messages: Message[], limit: number): number {
  if (estimateTokens(messages) <= limit) return 0;
  const { system, rounds } = splitRounds(messages);
  const before = messages.length;
  while (rounds.length > 1 && estimateTokens([...system, ...rounds.flat()]) > limit) rounds.shift();
  const kept = [...system, ...rounds.flat()];
  messages.length = 0;
  messages.push(...kept);
  // A single surviving round (one turn with huge tool output) can still exceed
  // the window — dropping whole rounds can't help. Clip the biggest message
  // bodies so the request stays valid instead of 400-ing on overflow.
  clipToFit(messages, limit);
  return before - messages.length;
}

/** Last-resort shrink: repeatedly halve the largest message body until the
 *  estimate fits. Only touches `content`, never tool_calls, so pairings stay
 *  valid. Stops when nothing worth clipping remains. */
function clipToFit(messages: Message[], limit: number): void {
  while (estimateTokens(messages) > limit) {
    let idx = -1;
    let max = 0;
    for (let i = 0; i < messages.length; i++) {
      const len = messages[i]!.content?.length ?? 0;
      if (len > max) {
        max = len;
        idx = i;
      }
    }
    if (idx < 0 || max < 400) return; // nothing large enough left to trim
    const m = messages[idx]!;
    m.content = `${m.content!.slice(0, Math.floor(max / 2))}\n…[truncated to fit context]`;
  }
}

/** Replace all but the last `keepRecent` rounds with one summary message (via the
 *  `summarize` callback). Mutates `messages` in place; returns how many messages
 *  were folded into the summary and the estimated tokens saved. */
export async function compact(
  messages: Message[],
  keepRecent: number,
  summarize: (transcript: string) => Promise<string>,
): Promise<{ summarized: number; savedTokens: number }> {
  const { system, rounds } = splitRounds(messages);
  if (rounds.length <= keepRecent) return { summarized: 0, savedTokens: 0 };
  const before = estimateTokens(messages);
  const old = rounds.slice(0, rounds.length - keepRecent).flat();
  const recent = rounds.slice(rounds.length - keepRecent).flat();
  const transcript = old.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");
  const summary: Message = {
    role: "user",
    content: `[Summary of earlier conversation]\n${await summarize(transcript)}`,
  };
  const kept = [...system, summary, ...recent];
  // A summary of already-short history can be longer than what it replaces — only
  // apply when it actually shrinks the context, so /compact never makes things worse.
  if (estimateTokens(kept) >= before) return { summarized: 0, savedTokens: 0 };
  messages.length = 0;
  messages.push(...kept);
  return { summarized: old.length, savedTokens: before - estimateTokens(messages) };
}
