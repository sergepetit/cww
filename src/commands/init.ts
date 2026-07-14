// cww init — explicitly (re)run the repo setup flow and preflight the
// machine. 'cww create' runs the same setup on its own the first time it
// sees a repo, so init exists for the deliberate cases: rotating an expired
// token, changing the clone URL, pinning a per-project agent, or checking a
// box is ready (docker, agent auth, agent image) without creating anything.

import { $ } from "bun";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { agentImage, agentLabel, agentPreflight, resolveAgent, validateAgent } from "../agents/registry";
import { loadEnvFile } from "../lib/env";
import { getGitRoot, isGitRepo } from "../lib/git";
import { resolveProjectPath } from "../lib/paths";
import { setupRepo } from "../lib/setup";
import { getProjectConfig, setProjectConfig } from "../lib/user-config";
import { GREEN, RED, NC, die, error, info, success } from "../lib/ui";

const USAGE = `Usage: cww init [project-path] [options]

Set a repository up for cww and preflight the machine:
  1. Pick the clone URL workspaces will use (derived from a git remote, or
     typed exactly — e.g. a self-hosted forge on plain http or a non-443
     port). Stored per project in ~/.cww/config.json.
  2. Store the git credential (user + fine-grained PAT for this repo or its
     host) in ~/.cww/credentials — validated with 'git ls-remote' before
     anything is saved. 'cww create' injects only the matching entry into a
     workspace.
  3. Check the rest: docker reachable, agent auth present, agent image built.

The first 'cww create' in a repo runs step 1–2 by itself; run init to rotate
a token, change the URL, or preflight without creating a workspace.

Arguments:
  project-path      Path to the git repository (default: current directory)

Options:
  --remote <name>   Git remote to derive the clone URL from (default: origin)
  --agent <name>    Agent to preflight: claude | vibe | opencode — also
                    recorded as this project's default agent
                    (otherwise: CWW_AGENT from ~/.cww/env, falling back to claude)
  -h, --help        Show this help message

Examples:
  cww init                       # From within the repo
  cww init --remote forge       # Clone URL from a non-origin remote
  cww init /path/to/repo         # Explicit path
`;

// The agents' preflight() contract is fail-fast: it prints instructions and
// calls process.exit. init wants a check mark instead of an abort, so exit is
// intercepted for the duration of the call (the instructions still print).
function preflightPasses(agent: Parameters<typeof agentPreflight>[0], projectPath: string): boolean {
  const realExit = process.exit;
  const abort = new Error("preflight-failed");
  process.exit = ((): never => {
    throw abort;
  }) as typeof process.exit;
  try {
    agentPreflight(agent, projectPath);
    return true;
  } catch (e) {
    if (e === abort) return false;
    throw e;
  } finally {
    process.exit = realExit;
  }
}

export async function runInit(argv: string[]): Promise<void> {
  let positionals: string[];
  let remoteArg: string | undefined;
  let agentArg: string | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        remote: { type: "string" },
        agent: { type: "string" },
      },
      allowPositionals: true,
    });
    if (parsed.values.help) {
      console.log(USAGE);
      return;
    }
    remoteArg = parsed.values.remote;
    agentArg = parsed.values.agent;
    if (agentArg) validateAgent(agentArg);
    positionals = parsed.positionals;
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  let projectPath = resolveProjectPath(positionals[0]);
  if (!(await isGitRepo(projectPath))) die(`Not a git repository: ${projectPath}`);
  const gitRoot = await getGitRoot(projectPath);
  if (gitRoot && gitRoot !== projectPath) {
    info(`Using git root: ${gitRoot}`);
    projectPath = gitRoot;
  }

  // Global env only (agent auth tokens, CWW_AGENT default) — per-project
  // settings live in ~/.cww/config.json.
  loadEnvFile(path.join(os.homedir(), ".cww", "env"));

  const cloneUrl = await setupRepo(projectPath, { remote: remoteArg });

  // An explicit --agent becomes the project's default agent.
  if (agentArg) setProjectConfig(projectPath, { agent: agentArg });

  // --- Preflight -----------------------------------------------------------
  console.log("");
  info("Preflight:");
  const ok = (label: string) => console.log(`  ${GREEN}✓${NC} ${label}`);
  const ko = (label: string, hint: string) => {
    console.log(`  ${RED}✗${NC} ${label} — ${hint}`);
    return false;
  };
  let ready = true;
  ok(`git clone URL + credential for ${cloneUrl}`);

  const docker = await $`docker info`.quiet().nothrow();
  if (docker.exitCode === 0) ok("docker daemon reachable");
  else ready = ko("docker daemon reachable", "start Docker (or check the docker context)");

  const agent = resolveAgent(agentArg || getProjectConfig(projectPath)?.agent || undefined);
  if (preflightPasses(agent, projectPath)) ok(`${agentLabel(agent)} auth present`);
  else ready = ko(`${agentLabel(agent)} auth present`, "see instructions above");

  const image = await $`docker image inspect ${agentImage(agent)}`.quiet().nothrow();
  if (image.exitCode === 0) ok(`agent image built (${agentImage(agent)})`);
  else ready = ko(`agent image built (${agentImage(agent)})`, `run: cww build ${agent}`);

  console.log("");
  if (ready) success("Ready. Create a workspace with: cww create <workspace-name>");
  else {
    error("Not ready yet — fix the ✗ items above and re-run 'cww init'.");
    process.exit(1);
  }
}
