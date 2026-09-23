import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadedContextFiles, systemPrompt } from "./config/context.js";
import { compact, estimateTokens, guardContext } from "./core/compaction.js";
import { mcpToolName } from "./core/mcp.js";
import { checkPermission } from "./core/permissions.js";
import { dockerCommand, wrapCommand } from "./core/sandbox.js";
import { registerTools, toolMap, toolSpecs, unregisterTools } from "./core/tools.js";
import { appendMessage, loadMessages } from "./session/session.js";

const tmp = () => mkdtempSync(join(tmpdir(), "hitch-"));
const read = toolMap.get("read_file")!;
const write = toolMap.get("write_file")!;
const edit = toolMap.get("edit_file")!;
const bash = toolMap.get("bash")!;

// --- tools: read_file ---

test("read_file numbers lines from 1", async () => {
  const f = join(tmp(), "a.txt");
  writeFileSync(f, "a\nb\nc");
  assert.equal(await read.run({ path: f }), "1\ta\n2\tb\n3\tc");
});

test("read_file honors offset and limit", async () => {
  const f = join(tmp(), "a.txt");
  writeFileSync(f, "a\nb\nc\nd");
  assert.equal(await read.run({ path: f, offset: 2, limit: 2 }), "2\tb\n3\tc");
});

test("read_file reports an empty file", async () => {
  const f = join(tmp(), "empty.txt");
  writeFileSync(f, "");
  assert.equal(await read.run({ path: f }), "(empty file)");
});

// --- tools: write_file ---

test("write_file creates parent directories", async () => {
  const f = join(tmp(), "deep/nested/x.txt");
  await write.run({ path: f, content: "hi" });
  assert.equal(readFileSync(f, "utf8"), "hi");
});

// --- tools: edit_file ---

test("edit_file replaces a unique string", async () => {
  const f = join(tmp(), "a.txt");
  writeFileSync(f, "hello world");
  await edit.run({ path: f, old_string: "world", new_string: "there" });
  assert.equal(readFileSync(f, "utf8"), "hello there");
});

test("edit_file rejects a missing string", async () => {
  const f = join(tmp(), "b.txt");
  writeFileSync(f, "abc");
  await assert.rejects(edit.run({ path: f, old_string: "xyz", new_string: "q" }), /not found/);
});

test("edit_file rejects an ambiguous string unless replace_all", async () => {
  const f = join(tmp(), "c.txt");
  writeFileSync(f, "x x x");
  await assert.rejects(edit.run({ path: f, old_string: "x", new_string: "y" }), /appears 3 times/);
  await edit.run({ path: f, old_string: "x", new_string: "y", replace_all: true });
  assert.equal(readFileSync(f, "utf8"), "y y y");
});

// --- tools: bash ---

test("bash returns command output", async () => {
  assert.equal(await bash.run({ command: "echo hello" }), "hello");
});

test("bash returns failures as text instead of throwing", async () => {
  const out = await bash.run({ command: "exit 3" });
  assert.match(out, /failed \(exit 3/);
});

test("bash times out and reports it", async () => {
  const out = await bash.run({ command: "sleep 5", timeout_ms: 50 });
  assert.match(out, /timed out/);
});

// --- tools: specs ---

test("toolSpecs emits a valid function schema per tool", () => {
  const specs = toolSpecs();
  assert.equal(specs.length, 4);
  for (const s of specs) {
    assert.equal(s.type, "function");
    assert.ok(s.function.name);
    assert.equal((s.function.parameters as any).type, "object");
  }
});

// --- sandbox (--docker) ---

test("wrapCommand is a no-op when the sandbox is off", () => {
  assert.equal(wrapCommand("echo hi"), "echo hi");
});

test("dockerCommand single-quotes cwd and the command (injection-safe)", () => {
  const wrapped = dockerCommand("/w", "abc123", "echo 'hi'");
  assert.equal(wrapped, `docker exec -w '/w' abc123 sh -c 'echo '\\''hi'\\'''`);
});

// --- mcp tool naming ---

test("mcpToolName namespaces and sanitizes to OpenAI-safe chars", () => {
  assert.equal(mcpToolName("fs", "read_file"), "mcp__fs__read_file");
  assert.equal(mcpToolName("my.server", "do:it"), "mcp__my_server__do_it");
  assert.ok(mcpToolName("s".repeat(80), "t").length <= 64);
});

test("registerTools/unregisterTools add and remove runtime tools (MCP raw jsonSchema)", () => {
  const before = toolSpecs().length;
  registerTools([
    {
      name: "mcp__x__do",
      description: "d",
      jsonSchema: { type: "object", properties: {} },
      risk: "exec",
      run: async () => "ok",
    },
  ]);
  const spec = toolSpecs().find((s) => s.function.name === "mcp__x__do");
  assert.ok(spec, "registered tool appears in specs");
  assert.equal((spec!.function.parameters as any).type, "object"); // raw jsonSchema passed through
  assert.ok(toolMap.has("mcp__x__do"));

  unregisterTools(["mcp__x__do"]);
  assert.equal(toolSpecs().length, before, "count restored after unregister");
  assert.equal(toolMap.has("mcp__x__do"), false);
});

// --- context compaction ---

test("estimateTokens grows with content", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const big = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
  assert.ok(small > 0 && big > small + 900);
});

test("guardContext drops oldest whole rounds, keeps system + recent + tool pairs", () => {
  const msgs: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", function: { name: "x", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "t1", content: "r1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ];
  // limit = just enough for system + the last round → the q1 round must be dropped
  const limit = estimateTokens([
    { role: "system", content: "sys" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
  const dropped = guardContext(msgs, limit);
  assert.equal(dropped, 4);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content, "sys"); // system kept
  assert.equal(msgs.at(-1).content, "a2"); // recent kept
  assert.equal(
    msgs.some((m) => m.role === "tool"),
    false,
    "no orphaned tool result — the whole round went",
  );
});

test("compact folds old rounds into one summary, keeps recent verbatim", async () => {
  const msgs: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
  ];
  const { summarized } = await compact(msgs, 1, async () => "SUMMARY");
  assert.equal(summarized, 4); // the two oldest rounds
  assert.equal(msgs[0].content, "sys");
  assert.match(msgs[1].content, /SUMMARY/);
  assert.equal(msgs.at(-1).content, "a3"); // last round kept verbatim
});

// --- permissions (security boundary) ---

test("safe tools never prompt", async () => {
  const r = await checkPermission(read, {}, "ask", async () => "n");
  assert.deepEqual(r, { ok: true });
});

test("readonly blocks writes and commands", async () => {
  const r = await checkPermission(bash, { command: "ls" }, "readonly", async () => "y");
  assert.equal(r.ok, false);
});

test("yolo approves without prompting", async () => {
  const r = await checkPermission(write, { path: "x" }, "yolo", async () => "n");
  assert.deepEqual(r, { ok: true });
});

test("ask + no denies", async () => {
  const r = await checkPermission(bash, { command: "rm -rf /" }, "ask", async () => "n");
  assert.equal(r.ok, false);
});

test("ask + yes approves", async () => {
  const r = await checkPermission(bash, { command: "ls" }, "ask", async () => "y");
  assert.deepEqual(r, { ok: true });
});

// Keep LAST: "all" flips the session-wide approve latch (module state, per process).
test("ask + all approves this and every later call", async () => {
  assert.deepEqual(await checkPermission(write, { path: "x" }, "ask", async () => "a"), {
    ok: true,
  });
  assert.deepEqual(await checkPermission(bash, { command: "ls" }, "ask", async () => "n"), {
    ok: true,
  });
});

// --- context ---

test("systemPrompt includes preamble, rules, cwd, and AGENTS.md", () => {
  const dir = tmp();
  writeFileSync(join(dir, "AGENTS.md"), "PROJECT RULE: be terse");
  const p = systemPrompt(dir);
  assert.match(p, /You are hitch/);
  assert.match(p, /<rules>/);
  assert.match(p, new RegExp(`cwd: ${dir}`));
  assert.match(p, /PROJECT RULE: be terse/);
});

test("loadedContextFiles lists a present AGENTS.md", () => {
  const dir = tmp();
  const f = join(dir, "AGENTS.md");
  writeFileSync(f, "x");
  assert.ok(loadedContextFiles(dir).includes(f));
});

// --- session ---

test("session round-trips messages as JSONL", () => {
  const f = join(tmp(), "s.jsonl");
  const msgs = [
    { role: "system", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
  ];
  for (const m of msgs) appendMessage(f, m);
  assert.deepEqual(loadMessages(f), msgs);
});

test("loadMessages returns [] for a missing file", () => {
  assert.deepEqual(loadMessages(join(tmp(), "nope.jsonl")), []);
});
