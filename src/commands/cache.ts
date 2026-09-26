// cww cache — provision a persistent, shared dependency-cache directory that
// workspaces can bind-mount.
//
// Why this exists: a workspace's agent runs as the in-container `developer`
// user, whose UID does NOT match your host user. A cache dir you create on the
// host is therefore owned by "someone else" from inside the container (under
// rootless Docker it even looks root-owned via the user-namespace mapping), so
// the agent can't write it and `npm install` / Maven / sbt fail with
// permission errors.
//
// The fix is a one-time `chown` of the host dir to the UID `developer` has
// inside the container. We run that chown from a throwaway root container so
// it works without host `sudo` and, under rootless, lands on the correct
// subuid automatically. The ownership lives on the host dir, so it persists
// across workspace teardown/recreate and is shared by all (even parallel)
// workspaces.
//
// The dir lives under ~/.cww/cache/ — a dedicated, machine-level location that
// you never write to directly, so its container-side ownership is harmless and
// your own ~/.npm, ~/.m2, etc. are left untouched.

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionCacheDir } from "../lib/cache-dir";
import { isWindows } from "../lib/paths";
import { die, info, success, warn } from "../lib/ui";
import { parseCommandArgs } from "./common";

// Well-known presets: <key> -> "<host-subdir>:<container-path>".
// The container paths match the cache locations the bundled toolchains use.
export const PRESET_MOUNTS: Record<string, string> = {
  npm: "npm/_cacache:/home/developer/.npm/_cacache",
  m2: "m2/repository:/home/developer/.m2/repository",
  ivy2: "ivy2/cache:/home/developer/.ivy2/cache",
  sbt: "sbt/boot:/home/developer/.sbt/boot",
  coursier: "coursier:/home/developer/.cache/coursier",
  gradle: "gradle/caches:/home/developer/.gradle/caches",
};

const PRESETS = Object.keys(PRESET_MOUNTS).join(" ");

const USAGE = `Usage: cww cache <preset> [--from <dir>]
       cww cache <name> <container-path> [--from <dir>]

Provision a persistent, shared dependency-cache directory under ~/.cww/cache/
and chown it so a workspace's in-container 'developer' user can write it. Then
add the printed volume line to your project's .cww/docker-compose.services.yml.

Presets (host dir under ~/.cww/cache/ -> container path):
  npm        npm/_cacache   -> /home/developer/.npm/_cacache
  m2         m2/repository  -> /home/developer/.m2/repository
  ivy2       ivy2/cache     -> /home/developer/.ivy2/cache
  sbt        sbt/boot       -> /home/developer/.sbt/boot
  coursier   coursier       -> /home/developer/.cache/coursier
  gradle     gradle/caches  -> /home/developer/.gradle/caches

Custom: give any <name> plus the absolute <container-path> to mount it at.

Options:
  --from <dir>   Prime the cache by copying an existing dir's contents first
                 (e.g. --from ~/.npm/_cacache for a warm start). One-shot copy.
  -h, --help     Show this help message

Examples:
  cww cache npm                              # provision the npm cache
  cww cache npm --from ~/.npm/_cacache       # ... primed from your host cache
  cww cache pip /home/developer/.cache/pip   # a custom cache
`;

export async function runCache(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE, { from: { type: "string" } });
  if (!args) return;
  const from = args.values.from ?? "";
  const positionals = args.positionals;

  if (positionals.length < 1) {
    console.log(USAGE);
    process.exit(1);
  }

  const name = positionals[0]!;
  let hostSubdir: string;
  let containerPath: string;
  const mountSpec = PRESET_MOUNTS[name];
  if (mountSpec) {
    // Known preset: host subdir + container path are predefined.
    if (positionals.length !== 1) die(`Preset '${name}' takes no container-path argument.`);
    const sep = mountSpec.indexOf(":");
    hostSubdir = mountSpec.slice(0, sep);
    containerPath = mountSpec.slice(sep + 1);
  } else {
    // Custom cache: require an absolute container path.
    if (positionals.length !== 2) {
      die(
        `Unknown preset '${name}'. For a custom cache: cww cache <name> <container-path>. Presets: ${PRESETS}`,
      );
    }
    hostSubdir = name;
    containerPath = positionals[1]!;
    if (!containerPath.startsWith("/")) {
      die(`Container path must be absolute (got '${containerPath}').`);
    }
  }

  const hostDir = path.join(os.homedir(), ".cww", "cache", hostSubdir);

  fs.mkdirSync(hostDir, { recursive: true });

  if (from) {
    if (fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
      info(`Priming from ${from} ...`);
      // cp -a copies past unreadable files; fs.cpSync (Windows has no cp)
      // stops at the first one, leaving a partial prime.
      let copied = true;
      if (isWindows()) {
        try {
          fs.cpSync(from, hostDir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        } catch {
          copied = false;
        }
      } else {
        copied = (await $`cp -a ${from}/. ${hostDir}/`.quiet().nothrow()).exitCode === 0;
      }
      if (!copied) warn("Priming copy hit some unreadable files; continuing.");
    } else {
      warn(`--from '${from}' is not a directory; skipping prime.`);
    }
  }

  // Create + hand ownership to the container 'developer' user (see lib/docker).
  info("Setting cache ownership for the in-container 'developer' user ...");
  if (!(await provisionCacheDir(hostDir))) die(`Failed to provision ${hostDir}.`);

  success(`Cache ready: ${hostDir}`);
  console.log(`
Add this to your project's .cww/docker-compose.services.yml, under a 'coder:'
service (it merges onto the base container):

  coder:
    volumes:
      - \${HOME}/.cww/cache/${hostSubdir}:${containerPath}

Then 'cww create' a workspace — the cache populates on first use and every later
workspace (even a fresh one) reuses it.`);
}
