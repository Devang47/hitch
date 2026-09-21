import OpenAI from "openai";
import { resolveApiKey, resolveModel } from "./settings.js";

/** Mutable so `/model` can switch it mid-session. cli.ts refines model with the --model flag. */
export const config = {
  model: resolveModel(),
  // Cap output per turn. Without it, providers reserve their full max output
  // (tens of thousands of tokens), which 402s low-balance keys and over-reserves
  // credit. ponytail: a hard cap can truncate a very large single edit mid-JSON;
  // raise HITCH_MAX_TOKENS if that bites.
  maxTokens: Number(process.env.HITCH_MAX_TOKENS) || 8192,
  // Optional OpenRouter provider routing, as JSON (e.g. pin a provider, disable
  // fallbacks). Passed straight through to the request. Undefined = OpenRouter decides.
  provider: parseProvider(process.env.HITCH_PROVIDER),
};

function parseProvider(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`hitch: ignoring HITCH_PROVIDER, not valid JSON: ${raw}`);
    return undefined;
  }
}

// Constructed lazily: the OpenAI client throws on a missing key at construction,
// and we don't want `--help` (or the friendly key check) to trip over that.
let instance: OpenAI | undefined;
export function client(): OpenAI {
  if (!instance) {
    instance = new OpenAI({
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: resolveApiKey(),
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/Devang47/hitch",
        "X-Title": "hitch",
      },
    });
  }
  return instance;
}
