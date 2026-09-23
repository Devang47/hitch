import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runTurn } from "./core/agent.js";
import { config } from "./core/llm.js";
import { type FakeServer, startFakeOpenRouter } from "./testkit.js";

let fake: FakeServer;
const noop = { out: () => {}, ask: async () => "y" };

before(async () => {
  fake = await startFakeOpenRouter();
  process.env.OPENROUTER_BASE_URL = fake.url; // read lazily when the client is first built
  process.env.OPENROUTER_API_KEY = "test-key";
});
after(async () => {
  await fake.close();
});

test("streams a text reply and accounts token usage", async () => {
  fake.setResponses([
    {
      deltas: [{ content: "Hello " }, { content: "world" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
    },
  ]);
  let out = "";
  const messages: any[] = [{ role: "user", content: "hi" }];
  const seen: any[] = [];
  const usage = await runTurn(messages, { out: (s) => (out += s), ask: noop.ask }, "yolo", (m) =>
    seen.push(m),
  );

  assert.match(out, /Hello world/);
  assert.equal(messages.at(-1).content, "Hello world");
  assert.deepEqual(usage, { prompt: 10, completion: 2, cost: 0.001 });
  assert.equal(seen.length, 1); // the assistant message
  assert.equal(fake.requests.length, 1);
  assert.ok(fake.requests[0].max_tokens > 0, "sends a max_tokens cap"); // avoids the 402 credit-reservation trap
});

test("merges streamed tool-call fragments, runs the tool, and loops to completion", async () => {
  fake.setResponses([
    {
      finish: "tool_calls",
      deltas: [
        {
          tool_calls: [
            { index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "" } },
          ],
        },
        { tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] },
        { tool_calls: [{ index: 0, function: { arguments: 'and":"echo hi"}' } }] },
      ],
    },
    { deltas: [{ content: "done" }] },
  ]);
  const messages: any[] = [{ role: "user", content: "run it" }];
  await runTurn(messages, noop, "yolo", () => {});

  assert.equal(fake.requests.length, 2, "looped: tool result fed back for a second call");
  const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.name, "bash");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { command: "echo hi" });
  const toolResult = messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /hi/);
  assert.equal(messages.at(-1).content, "done");
});

test("fallback chain sends OpenRouter's `models` array; none sends plain model", async () => {
  const savedFallbacks = config.fallbacks;
  const savedModel = config.model;
  try {
    fake.setResponses([{ deltas: [{ content: "ok" }] }]);
    config.model = "a/primary";
    config.fallbacks = ["b/backup", "c/backup"];
    await runTurn([{ role: "user", content: "hi" }], noop, "yolo", () => {});
    assert.deepEqual(fake.requests[0].models, ["a/primary", "b/backup", "c/backup"]);

    fake.setResponses([{ deltas: [{ content: "ok" }] }]);
    config.fallbacks = [];
    await runTurn([{ role: "user", content: "hi" }], noop, "yolo", () => {});
    assert.equal(fake.requests[0].models, undefined, "no `models` key without fallbacks");
  } finally {
    config.fallbacks = savedFallbacks;
    config.model = savedModel;
  }
});

test("caching adds a system-prompt cache_control breakpoint only for anthropic/gemini", async () => {
  const savedModel = config.model;
  try {
    fake.setResponses([{ deltas: [{ content: "ok" }] }]);
    config.model = "google/gemini-x"; // exercises the same anthropic|google caching branch
    const system = { role: "system", content: "you are hitch" };
    await runTurn([system, { role: "user", content: "hi" }] as any, noop, "yolo", () => {});
    const sent = fake.requests[0].messages[0];
    assert.equal(sent.content[0].cache_control.type, "ephemeral");
    assert.equal(sent.content[0].text, "you are hitch");

    fake.setResponses([{ deltas: [{ content: "ok" }] }]);
    config.model = "openai/gpt";
    await runTurn([system, { role: "user", content: "hi" }] as any, noop, "yolo", () => {});
    assert.equal(fake.requests[0].messages[0].content, "you are hitch", "unchanged for others");
  } finally {
    config.model = savedModel;
  }
});

test("an already-aborted signal returns without calling the model", async () => {
  fake.setResponses([{ deltas: [{ content: "should not be sent" }] }]);
  const ac = new AbortController();
  ac.abort();
  const messages: any[] = [{ role: "user", content: "hi" }];
  const usage = await runTurn(messages, noop, "yolo", () => {}, ac.signal);
  assert.equal(fake.requests.length, 0, "no request fired when already interrupted");
  assert.deepEqual(usage, { prompt: 0, completion: 0, cost: 0 });
});

test("a denied tool call is not executed", async () => {
  const target = join(tmpdir(), `hitch-should-not-exist-${process.pid}.txt`);
  fake.setResponses([
    {
      finish: "tool_calls",
      deltas: [
        {
          tool_calls: [
            {
              index: 0,
              id: "w1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: target, content: "nope" }),
              },
            },
          ],
        },
      ],
    },
    { deltas: [{ content: "skipped it" }] },
  ]);
  const messages: any[] = [{ role: "user", content: "write it" }];
  await runTurn(messages, { out: () => {}, ask: async () => "n" }, "ask", () => {});

  assert.equal(existsSync(target), false, "file was not written");
  const toolResult = messages.find((m) => m.role === "tool");
  assert.match(toolResult.content, /rejected/);
});
