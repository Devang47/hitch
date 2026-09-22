import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Free by default so hitch runs at $0 out of the box. Free slugs rotate — swap
// via `/models --default`, HITCH_MODEL, or --model.
const FALLBACK_MODEL = "nvidia/nemotron-3.5-lightning:free";

/** One MCP server: a command hitch spawns and talks to over stdio. */
export type McpServer = { command: string; args?: string[]; env?: Record<string, string> };

type Config = {
  apiKey?: string;
  defaultModel?: string;
  fallbackModels?: string[];
  mcpServers?: Record<string, McpServer>;
};

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
/** Ordered models tried after the primary via OpenRouter's `models` param.
 *  Env (comma-separated) wins over the config array. */
export function resolveFallbacks(): string[] {
  const env = process.env.HITCH_FALLBACK_MODELS;
  if (env)
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return read().fallbackModels ?? [];
}
export function resolveMcpServers(): Record<string, McpServer> {
  return read().mcpServers ?? {};
}
export function setMcpServer(name: string, server: McpServer): void {
  write({ mcpServers: { ...read().mcpServers, [name]: server } });
}
export function removeMcpServer(name: string): boolean {
  const mcpServers = { ...read().mcpServers };
  if (!(name in mcpServers)) return false;
  delete mcpServers[name];
  write({ mcpServers });
  return true;
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
