import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { fetchCatalog, searchModels } from "./models.js";
import { configFile, resolveApiKey, resolveModel, setApiKey, setDefaultModel } from "./settings.js";

// Fresh sandbox home per test; settings/models read HITCH_HOME lazily.
beforeEach(() => {
  process.env.HITCH_HOME = mkdtempSync(join(tmpdir(), "hitch-cfg-"));
  delete process.env.HITCH_MODEL;
  delete process.env.OPENROUTER_API_KEY;
});

test("resolveModel precedence: flag > env > config > fallback", () => {
  assert.equal(resolveModel(), "anthropic/claude-sonnet-4.5");
  setDefaultModel("cfg/model");
  assert.equal(resolveModel(), "cfg/model");
  process.env.HITCH_MODEL = "env/model";
  assert.equal(resolveModel(), "env/model");
  assert.equal(resolveModel("flag/model"), "flag/model");
});

test("resolveApiKey precedence: env > config", () => {
  assert.equal(resolveApiKey(), undefined);
  setApiKey("cfgkey");
  assert.equal(resolveApiKey(), "cfgkey");
  process.env.OPENROUTER_API_KEY = "envkey";
  assert.equal(resolveApiKey(), "envkey");
});

test("setDefaultModel persists to config.json", () => {
  setDefaultModel("x/y");
  assert.equal(JSON.parse(readFileSync(configFile(), "utf8")).defaultModel, "x/y");
});

test("searchModels filters by id and name; empty query returns all", () => {
  const models = [
    { id: "anthropic/claude", name: "Claude", contextLength: 0, promptPrice: 0, tools: true },
    { id: "openai/gpt", name: "GPT-5", contextLength: 0, promptPrice: 0, tools: true },
  ];
  assert.equal(searchModels(models, "claude").length, 1);
  assert.equal(searchModels(models, "gpt")[0]?.id, "openai/gpt");
  assert.equal(searchModels(models, "").length, 2);
});

test("fetchCatalog serves fresh cache without hitting the network", async () => {
  const cache = {
    fetchedAt: Date.now(),
    models: [{ id: "cached/model", name: "", contextLength: 0, promptPrice: 0, tools: false }],
  };
  writeFileSync(join(process.env.HITCH_HOME as string, "models.json"), JSON.stringify(cache));
  assert.equal((await fetchCatalog())[0]?.id, "cached/model");
});
