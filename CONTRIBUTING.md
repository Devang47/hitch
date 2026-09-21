# Contributing to hitch

Thanks for looking! hitch is deliberately small — the whole agent is a handful
of files in `src/`. Read them; you'll have the full picture in ten minutes.

## Setup

```bash
npm install
cp .env.example .env    # add your OPENROUTER_API_KEY
npm run dev             # run from source
npm test                # unit tests
npm run check           # lint + format check (biome)
npm run fix             # auto-fix
```

## Layout

| File | Responsibility |
|------|----------------|
| `src/cli.ts`         | arg parsing, REPL, slash commands, startup header |
| `src/agent.ts`       | the loop: stream → tool calls → dispatch → repeat |
| `src/tools.ts`       | the four tools + their JSON schemas |
| `src/permissions.ts` | the approval gate |
| `src/context.ts`     | system prompt + AGENTS.md assembly |
| `src/session.ts`     | JSONL persistence + resume |
| `src/llm.ts`         | the OpenRouter client |

## The bar

The point of hitch is that it stays small and readable. Before adding a
feature, ask whether it belongs in core or as something the model can already do
through `bash`. New runtime dependencies need a good reason. Match the
surrounding style; run `npm run fix` before opening a PR.

Good first issues are tagged on the tracker. For anything larger than a bug fix,
open an issue first so we can agree on the approach.
