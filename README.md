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
npx @devang47/hitch    # first run prompts for your OpenRouter key and a default model
```

Or set the key up front and go in one shot:

```bash
export OPENROUTER_API_KEY=sk-or-...   # https://openrouter.ai/keys
npx @devang47/hitch "explain what this repo does, then add a test for the parser"
```

Or clone and run from source:

```bash
git clone https://github.com/Devang47/hitch && cd hitch
npm install
cp .env.example .env    # add your key
npm run dev             # interactive session
```

## Usage

```
hitch [prompt]           start a session (optional first prompt)

  --model <id>           model to use (default: a free model; override w/ $HITCH_MODEL or config)
  --resume               continue the most recent session in this directory
  --yolo                 auto-approve every tool call (no prompts)
  --readonly             allow reads only; block writes and commands
  -h, --help             show this help

In-session commands:
  /model [query]         pick the model for THIS session (searchable, live from OpenRouter)
  /models --default      set the default model for all new sessions
  /models --refresh      refresh the model list
  /cost                  show token + cost totals
  /help                  show help
  /exit                  quit
```

Model choice is scoped: `/model` changes only the current session; `/models --default`
(and first-run setup) sets the global default in `~/.hitch/config.json` for new sessions.

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
| `OPENROUTER_API_KEY` | your OpenRouter key (or set it via first-run setup) |
| `HITCH_MODEL` | override the default model for this run (any id from openrouter.ai/models) |
| `HITCH_MAX_TOKENS` | max output tokens per turn (default 8192) |
| `HITCH_PROVIDER` | OpenRouter [provider routing](https://openrouter.ai/docs/features/provider-routing) as JSON, e.g. `{"only":["morph"]}` |
| `HITCH_HOME` | config/cache dir (default `~/.hitch`) |

The key and default model persist in `~/.hitch/config.json` (mode `600`). A `.env`
file in the working directory is loaded automatically, and env vars override the config file.

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
