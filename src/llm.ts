import OpenAI from "openai";

/** Mutable so `/model` can switch it mid-session. */
export const config = {
  model: process.env.HITCH_MODEL || "anthropic/claude-sonnet-4.5",
};

// Constructed lazily: the OpenAI client throws on a missing key at construction,
// and we don't want `--help` (or the friendly key check) to trip over that.
let instance: OpenAI | undefined;
export function client(): OpenAI {
  if (!instance) {
    instance = new OpenAI({
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/kitatsu/hitch",
        "X-Title": "hitch",
      },
    });
  }
  return instance;
}
