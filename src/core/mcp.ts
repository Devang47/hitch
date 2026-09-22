import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "../config/settings.js";
import { registerTools, type Tool, unregisterTools } from "./tools.js";

// Manages MCP servers connected over stdio: connect one (registering its tools
// live), disconnect one (unregistering them), and close all on exit. Tool names
// are namespaced (`mcp__server__tool`) but callTool uses the server's original
// name. Tools are gated as "exec" so they route through the permission prompt
// like bash. Only stdio transport for now — add SSE/HTTP if a server needs it.

const connected = new Map<string, { client: Client; toolNames: string[] }>();

/** Namespaced, OpenAI-safe tool name (chars `[a-zA-Z0-9_-]`, ≤64). */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

function textOf(res: any): string {
  const parts = (res?.content ?? []).map((p: any) => (p.type === "text" ? p.text : `[${p.type}]`));
  const text = parts.join("\n").trim();
  if (res?.isError) return `Error: ${text || "tool failed"}`;
  return text || "(no output)";
}

/** Connect one server and register its tools live. Returns the tool count; throws
 *  on failure (already connected, or the server won't start). */
export async function connectServer(name: string, spec: McpServer): Promise<number> {
  if (connected.has(name)) throw new Error(`"${name}" is already connected`);
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env } as Record<string, string>,
  });
  const client = new Client({ name: "hitch", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const list = await client.listTools();
  const tools: Tool[] = list.tools.map((t) => ({
    name: mcpToolName(name, t.name),
    description: t.description ?? "",
    jsonSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    risk: "exec",
    run: async (args) => textOf(await client.callTool({ name: t.name, arguments: args })),
  }));
  registerTools(tools);
  connected.set(name, { client, toolNames: tools.map((t) => t.name) });
  return tools.length;
}

/** Disconnect a server and unregister its tools. Returns false if not connected. */
export async function disconnectServer(name: string): Promise<boolean> {
  const entry = connected.get(name);
  if (!entry) return false;
  connected.delete(name);
  unregisterTools(entry.toolNames);
  await entry.client.close().catch(() => {});
  return true;
}

/** Connect every configured server (best-effort; logs failures). Returns the
 *  total tool count across servers that connected. */
export async function connectAll(servers: Record<string, McpServer>): Promise<number> {
  let total = 0;
  for (const [name, spec] of Object.entries(servers)) {
    try {
      total += await connectServer(name, spec);
    } catch (e: any) {
      console.error(`hitch: MCP server "${name}" failed: ${e?.message ?? e}`);
    }
  }
  return total;
}

export async function closeAll(): Promise<void> {
  const entries = [...connected.values()];
  connected.clear();
  for (const e of entries) await e.client.close().catch(() => {});
}

/** Names of currently-connected servers. */
export function connectedServers(): string[] {
  return [...connected.keys()];
}

/** Live tool count for a connected server (0 if not connected). */
export function toolCount(name: string): number {
  return connected.get(name)?.toolNames.length ?? 0;
}
