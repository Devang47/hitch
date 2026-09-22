import { execFileSync } from "node:child_process";

// --docker sandbox: run the `bash` tool inside a throwaway container instead of
// on the host. The cwd is bind-mounted at the same path, so the file tools
// (host fs) and bash (container) see the same working directory — only command
// execution is isolated (installed tools, processes, network, fs outside cwd).

let containerId: string | undefined;
let mountedCwd = "";

const image = () => process.env.HITCH_DOCKER_IMAGE || "node:20-slim";

/** Single-quote a string for POSIX sh (`'` → `'\''`). */
const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** The docker-exec form of a shell command. Exported for testing. */
export function dockerCommand(cwd: string, id: string, command: string): string {
  return `docker exec -w ${sh(cwd)} ${id} sh -c ${sh(command)}`;
}

/** Wrap a bash command to run inside the sandbox (no-op when sandboxing is off). */
export function wrapCommand(command: string): string {
  return containerId ? dockerCommand(mountedCwd, containerId, command) : command;
}

export function sandboxImage(): string {
  return image();
}

/** Start a detached container with `cwd` bind-mounted, and register cleanup.
 *  Throws if docker isn't available/running — the caller reports it. */
export function startSandbox(cwd: string): string {
  const id = execFileSync(
    "docker",
    ["run", "-d", "--rm", "-v", `${cwd}:${cwd}`, "-w", cwd, image(), "sleep", "infinity"],
    { encoding: "utf8" },
  ).trim();
  containerId = id;
  mountedCwd = cwd;

  // ponytail: best-effort cleanup on normal exit + Ctrl-C. A SIGKILL leaks the
  // container (`docker rm -f <id>` to clear). Add a reaper only if that bites.
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    } catch {}
  };
  process.once("exit", stop);
  process.once("SIGINT", () => process.exit(130)); // fires 'exit' → stop
  return id;
}
