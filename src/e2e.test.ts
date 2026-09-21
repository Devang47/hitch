import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { type FakeServer, startFakeOpenRouter } from "./testkit.js";

// Runs the built binary (npm test builds first). cwd is a throwaway dir so there's
// no local .env / AGENTS.md interference and sessions land in the sandbox.
//
// Uses async spawn, NOT execFileSync: the fake server runs in this process, and a
// synchronous spawn would block the event loop so the server could never answer
// the child's request — deadlock.
const CLI = resolve("dist/cli.js");
let fake: FakeServer;
let dir: string;

before(async () => {
  fake = await startFakeOpenRouter();
  dir = mkdtempSync(join(tmpdir(), "hitch-e2e-"));
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  extraEnv: Record<string, string>,
  input = "",
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rej);
    child.on("close", (code) => res({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

test("--help prints usage and exits 0", async () => {
  const { stdout, code } = await run(["--help"], {});
  assert.equal(code, 0);
  assert.match(stdout, /usage: hitch/);
});

test("missing key exits 1 with a helpful message", async () => {
  const { stderr, code } = await run(["hi"], { OPENROUTER_API_KEY: "" });
  assert.equal(code, 1);
  assert.match(stderr, /Missing OPENROUTER_API_KEY/);
});

test("a one-shot prompt runs end to end against the API", async () => {
  fake.setResponses([
    {
      deltas: [{ content: "Hi from hitch" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.0002 },
    },
  ]);
  const { stdout, code } = await run(["say hi"], {
    OPENROUTER_API_KEY: "test",
    OPENROUTER_BASE_URL: fake.url,
  });
  assert.equal(code, 0);
  assert.match(stdout, /Hi from hitch/);
});
