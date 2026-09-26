// cww cp — copy files between the host and a running workspace, scp-style.
// Wraps 'docker cp' so you never need the container name, and hands pushed
// files to the in-container 'developer' user instead of leaving them
// root-owned.

import fs from "node:fs";
import path from "node:path";
import { copyFromContainer, copyIntoContainer } from "../lib/container-fs";
import { containerRunning } from "../lib/docker";
import { isDrivePath } from "../lib/paths";
import { die, error, success } from "../lib/ui";
import { parseCommandArgs, resolveContainerLoosely } from "./common";

const USAGE = `Usage: cww cp <source>... <workspace>:<dest>
       cww cp <workspace>:<source>... <dest>

Copy files or directories between the host and a running workspace (scp-style).
Exactly one side names a workspace via the '<workspace>:<path>' form; an empty
workspace name (':<path>') auto-detects the workspace from the current repo.
Relative in-container paths resolve against /workspace, and pushed files are
owned by 'developer' inside the container.

Arguments:
  source...        What to copy: host paths, or '<workspace>:<path>' entries
  dest             Where to copy it (the other side)

Options:
  -h, --help       Show this help message

Examples:
  cww cp notes.md sandbox:docs/     # Host file into the workspace's /workspace/docs/
  cww cp notes.md sandbox:          # ... into /workspace
  cww cp fixtures/ :data/           # A directory, workspace auto-detected
  cww cp sandbox:out.log .          # Pull a file out of the workspace
  cww cp ./with:colon sandbox:      # A './' prefix escapes a literal ':' in a host path
`;

// 'name:path' with a plausible workspace name (or empty = auto-detect). A '/'
// before the ':' means a host path that merely contains a colon — the same
// './' escape convention as scp. On Windows a drive path ('C:\x', 'C:/x') is
// always a host path.
const REMOTE_RE = /^([A-Za-z0-9._-]*):(.*)$/;

export type CpPlan = {
  direction: "push" | "pull";
  // undefined → auto-detect from the current repo, like other commands.
  workspace: string | undefined;
  // Host paths for a push; absolute in-container paths for a pull.
  sources: string[];
  // Absolute in-container path for a push; host path for a pull.
  dest: string;
};

// Resolve an in-container path against the workspace checkout. '' (from a
// bare 'ws:') means /workspace itself. Trailing slashes survive — they mark
// the path as a directory for the copy helpers.
export function resolveContainerPath(p: string): string {
  if (p === "") return "/workspace";
  return path.posix.isAbsolute(p) ? p : `/workspace/${p}`;
}

// Pure argument planner (throws on invalid combinations, no I/O).
export function parseCpArgs(positionals: string[], platform: NodeJS.Platform = process.platform): CpPlan {
  if (positionals.length < 2) {
    throw new Error("cww cp needs at least a source and a destination.");
  }
  const sources = positionals.slice(0, -1);
  const dest = positionals[positionals.length - 1]!;

  const remote = (arg: string) => (isDrivePath(arg, platform) ? null : REMOTE_RE.exec(arg));
  const destRemote = remote(dest);
  const remoteSources = sources.map(remote);
  const remoteSourceCount = remoteSources.filter(Boolean).length;

  if (destRemote && remoteSourceCount > 0) {
    throw new Error(
      "Both sides name a workspace; workspace-to-workspace copy is not supported.",
    );
  }

  if (destRemote) {
    return {
      direction: "push",
      workspace: destRemote[1] || undefined,
      sources,
      dest: resolveContainerPath(destRemote[2]!),
    };
  }

  if (remoteSourceCount === 0) {
    throw new Error(
      "Neither side names a workspace. Use '<workspace>:<path>' (or ':<path>' to auto-detect) on the side inside the workspace.",
    );
  }
  if (remoteSourceCount < sources.length) {
    throw new Error("Cannot mix workspace and host sources in one copy.");
  }

  const names = new Set(remoteSources.map((m) => m![1]));
  if (names.size > 1) {
    throw new Error("All workspace sources must name the same workspace.");
  }
  return {
    direction: "pull",
    workspace: [...names][0] || undefined,
    sources: remoteSources.map((m) => resolveContainerPath(m![2]!)),
    dest,
  };
}

export async function runCp(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE);
  if (!args) return;

  let plan: CpPlan;
  try {
    plan = parseCpArgs(args.positionals);
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    console.log(USAGE);
    process.exit(1);
  }

  const { workspace, container } = await resolveContainerLoosely(plan.workspace, USAGE);
  if (!(await containerRunning(container))) {
    die(`Workspace '${workspace}' is not running. Start it with: cww start ${workspace}`);
  }

  if (plan.direction === "push") {
    const missing = plan.sources.filter((s) => !fs.existsSync(s));
    if (missing.length > 0) {
      die(`No such file or directory: ${missing.join(", ")}`);
    }
    const copied = await copyIntoContainer(plan.sources, container, plan.dest);
    copied.forEach((target, i) => success(`${plan.sources[i]} -> ${workspace}:${target}`));
  } else {
    if (
      (plan.sources.length > 1 || plan.dest.endsWith("/")) &&
      !(fs.existsSync(plan.dest) && fs.statSync(plan.dest).isDirectory())
    ) {
      die(`Destination is not a directory: ${plan.dest}`);
    }
    const copied = await copyFromContainer(container, plan.sources, plan.dest);
    copied.forEach((target, i) => success(`${workspace}:${plan.sources[i]} -> ${target}`));
  }
}
