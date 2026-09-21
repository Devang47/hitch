import { createServer } from "node:http";

// A fake OpenRouter/OpenAI streaming endpoint, in stdlib http. Lets integration
// and e2e tests exercise the real openai SDK + our SSE/tool-call parsing without
// a network or a mocking library. Not shipped (excluded from the build).

export type Delta = { role?: string; content?: string; tool_calls?: unknown[] };
export type FakeResponse = { deltas: Delta[]; finish?: string; usage?: Record<string, number> };

export type FakeServer = {
  url: string;
  /** Request bodies received, in order. */
  requests: any[];
  /** Queue the responses to stream for the next N model calls; resets counters. */
  setResponses: (responses: FakeResponse[]) => void;
  close: () => Promise<void>;
};

export function startFakeOpenRouter(): Promise<FakeServer> {
  let responses: FakeResponse[] = [];
  let next = 0;
  const requests: any[] = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        requests.push(JSON.parse(body || "{}"));
      } catch {
        requests.push(body);
      }
      // Clamp to the last response so extra loop turns still get something valid.
      const r = responses[Math.min(next++, responses.length - 1)] ?? {
        deltas: [{ content: "ok" }],
      };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      for (const delta of r.deltas) send({ choices: [{ index: 0, delta }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: r.finish ?? "stop" }] });
      if (r.usage) send({ choices: [], usage: r.usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/api/v1`,
        requests,
        setResponses: (rs) => {
          responses = rs;
          next = 0;
          requests.length = 0;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
