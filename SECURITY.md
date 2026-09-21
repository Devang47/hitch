# Security

## The threat model, plainly

hitch runs an LLM that can execute shell commands and write files on your
machine. That is the feature. It is also the risk.

**The permission gate is a speed bump, not a sandbox.** By default hitch asks
before every `bash`, `write_file`, and `edit_file` call. But once you approve a
command, it runs with *your* full user permissions — same as if you typed it.
`--yolo` removes the prompt entirely. `--readonly` blocks all writes and commands.

For real isolation (untrusted code, autonomous runs, `--yolo`), run hitch inside
a container or throwaway VM. Do not point `--yolo` at a repo you don't trust.

## What hitch does and doesn't send

- Your prompts, file contents the model reads, and tool results are sent to
  OpenRouter and on to the model provider you select. Don't feed it secrets you
  wouldn't paste into a chat box.
- Your API key is read from the environment / `.env` and sent only to OpenRouter.
- hitch has no telemetry and phones nowhere else.

## Reporting a vulnerability

Open a private security advisory on the GitHub repo, or email the maintainer.
Please don't file public issues for exploitable bugs.
