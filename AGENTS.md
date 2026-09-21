# AGENTS.md — hitch

Instructions for coding agents (including hitch itself) working in this repo.

- hitch is a minimal coding agent. Keep it minimal. The whole agent should stay
  readable in one sitting. Prefer deleting code over adding it.
- TypeScript, ESM, Node ≥ 20. Relative imports use `.js` extensions (NodeNext).
- Two runtime deps only: `openai` (pointed at OpenRouter) and `zod`. Don't add
  more without a strong reason.
- Run `npm run fix` (biome) and `npm test` before considering a change done.
- New behavior with real logic gets one small `node:test` case in `src/*.test.ts`.
  No frameworks, no fixtures.
- Never weaken the permission gate's defaults. Safe tools stay safe; `write`,
  `edit`, and `bash` stay gated unless the user explicitly opts out.
