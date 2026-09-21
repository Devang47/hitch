import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { search } from "@inquirer/prompts";
import { hitchHome } from "./settings.js";

export type Model = {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number; // USD per token
  tools: boolean;
};

const cachePath = () => join(hitchHome(), "models.json");
const TTL_MS = 24 * 60 * 60 * 1000;

/** OpenRouter's public catalog. Cached; falls back to stale cache when offline. */
export async function fetchCatalog(force = false): Promise<Model[]> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.models;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
    const json = (await res.json()) as { data?: unknown[] };
    const models = (json.data ?? []).map(toModel);
    writeCache(models);
    return models;
  } catch (e) {
    if (cached) return cached.models;
    throw e;
  }
}

function toModel(m: any): Model {
  return {
    id: m.id,
    name: m.name ?? "",
    contextLength: m.context_length ?? 0,
    promptPrice: Number(m.pricing?.prompt ?? 0),
    tools: (m.supported_parameters ?? []).includes("tools"),
  };
}

/** Case-insensitive substring match on id + name. Empty query returns all. */
export function searchModels(models: Model[], query: string): Model[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q));
}

function priceLabel(m: Model): string {
  const price = m.promptPrice > 0 ? `$${(m.promptPrice * 1e6).toFixed(2)}/M in` : "free";
  const ctx = m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : "";
  return `${price}${ctx}${m.tools ? " · tools" : ""}`;
}

/** Interactive filter-as-you-type picker. Returns the chosen id, or undefined if cancelled. */
export async function pickModel(): Promise<string | undefined> {
  const models = await fetchCatalog();
  try {
    return await search({
      message: "Model (type to search)",
      source: (term) =>
        searchModels(models, term ?? "")
          .slice(0, 30)
          .map((m) => ({ name: m.id, value: m.id, description: priceLabel(m) })),
    });
  } catch {
    return undefined; // Ctrl-C / Esc
  }
}

type Cache = { fetchedAt: number; models: Model[] };
function readCache(): Cache | undefined {
  const path = cachePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
function writeCache(models: Model[]): void {
  mkdirSync(hitchHome(), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), models }));
}
