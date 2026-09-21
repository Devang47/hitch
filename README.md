# hitch

**A minimal, OpenRouter-native coding agent for your terminal.**

hitch is a coding agent in ~500 lines: an LLM, four tools (read, write, edit,
bash), and a loop. It's built in the spirit of [pi](https://github.com/earendil-works/pi) —
tiny prompt, no ceremony — but it talks to a single endpoint ([OpenRouter](https://openrouter.ai)),
so it drops the multi-provider machinery and adds the three things pi leaves out:

- **A permission gate.** Every command and file write asks before it runs (unless you say otherwise). pi runs with your full shell permissions by design; hitch defaults to *ask*.
- **A live cost meter.** OpenRouter reports usage per request, so hitch shows you `$` spent as you go.
- **Session resume.** Every turn is logged to JSONL; `--resume` picks up where you left off.

Any of 300+ models, one API key. Swap models mid-session with `/model`.

## Quickstart

```bash
export OPENROUTER_API_KEY=sk-or-...   # https://openrouter.ai/keys
npx hitch "explain what this repo does, then add a test for the parser"
```

Or clone and run from source:

```bash
git clone https://github.com/kitatsu/hitch && cd hitch
npm install
cp .env.example .env    # add your key
npm run dev             # interactive session
```

## Usage

```
hitch [prompt]           start a session (optional first prompt)

  --model <id>           model to use (default: $HITCH_MODEL or anthropic/claude-sonnet-4.5)
  --resume               continue the most recent session in this directory
  --yolo                 auto-approve every tool call (no prompts)
  --readonly             allow reads only; block writes and commands
  -h, --help             show this help

In-session commands:
  /model [id]            show or switch the model
  /cost                  show token + cost totals
  /help                  show help
  /exit                  quit
```

## The four tools

| Tool | What it does | Approval |
|------|--------------|----------|
| `read_file`  | read a file (with line numbers)        | never |
| `write_file` | create/overwrite a file               | asks |
| `edit_file`  | exact string replacement in a file    | asks |
| `bash`       | run a shell command in the cwd         | asks |

Everything else — search, git, tests, installing deps — the model does through
`bash`. That's the whole point: four primitives, and the model composes the rest.

## Context

hitch loads instructions from `AGENTS.md` (project root) and `~/.hitch/AGENTS.md`
(global), and injects your cwd, OS, and date. Keep project conventions in
`AGENTS.md` and the agent will follow them.

## Configuration

| Env var | Purpose |
|---------|---------|
| `OPENROUTER_API_KEY` | required — your OpenRouter key |
| `HITCH_MODEL` | default model id (any from openrouter.ai/models) |

A `.env` file in the working directory is loaded automatically.

## Safety

hitch's permission gate is a speed bump, **not a sandbox** — an approved `bash`
command runs with your full user permissions. Review what it asks to run, use
`--readonly` for untrusted repos, and run inside a container or VM for real
isolation. See [SECURITY.md](./SECURITY.md).

## Roadmap

- [ ] MCP client (use the wider tool ecosystem)
- [ ] `--docker` sandbox mode
- [ ] Model fallback chains (OpenRouter `models: [...]`)
- [ ] Prompt caching
- [ ] Sub-agents

## License

MIT — see [LICENSE](./LICENSE).
