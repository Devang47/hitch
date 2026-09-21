import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Free by default so hitch runs at $0 out of the box. Free slugs rotate — swap
// via `/models --default`, HITCH_MODEL, or --model.
const FALLBACK_MODEL = "nvidia/nemotron-3.5-lightning:free";

type Config = { apiKey?: string; defaultModel?: string };

/** Config/cache dir. HITCH_HOME relocates it (also the seam tests use). */
export function hitchHome(): string {
  return process.env.HITCH_HOME || join(homedir(), ".hitch");
}
const configPath = () => join(hitchHome(), "config.json");

function read(): Config {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function write(patch: Config): void {
  mkdirSync(hitchHome(), { recursive: true });
  const path = configPath();
  writeFileSync(path, JSON.stringify({ ...read(), ...patch }, null, 2));
  chmodSync(path, 0o600); // holds the API key
}

/** Env wins so CI / power users and per-shell overrides keep working. */
export function resolveApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || read().apiKey;
}
export function resolveModel(flag?: string): string {
  return flag || process.env.HITCH_MODEL || read().defaultModel || FALLBACK_MODEL;
}
export function setApiKey(apiKey: string): void {
  write({ apiKey });
}
export function setDefaultModel(defaultModel: string): void {
  write({ defaultModel });
}
export function configFile(): string {
  return configPath();
}
