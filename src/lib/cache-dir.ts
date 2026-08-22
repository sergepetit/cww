// Dependency-cache provisioning.
//
// A workspace's agent runs as the in-container `developer` user, whose UID
// never matches the host user, so a host-owned bind-mount dir isn't writable
// from inside (under rootless Docker it even looks root-owned). These helpers
// create such a dir and hand its ownership to `developer`, so npm/Maven/sbt
// caches shared from the host are writable. Used by `cww cache` and
// auto-provisioning on create.
//
// Split out of docker.ts because resolving "any cww image" is the one thing
// here that needs the agent registry, and docker.ts is otherwise registry-free
// plumbing.

import { $ } from "bun";
import fs from "node:fs";
import { CWW_AGENTS } from "../agents/registry";
import { error } from "./ui";

// Any locally-built cww image works for these helpers — the `developer` user
// is identical across the per-agent images (they share the same base image).
export async function findAnyCwwImage(): Promise<string | null> {
  for (const tag of [...CWW_AGENTS, "latest"]) {
    const image = `coder-workspace-workflow:${tag}`;
    const r = await $`docker image inspect ${image}`.quiet().nothrow();
    if (r.exitCode === 0) return image;
  }
  return null;
}

// The `developer` UID:GID from the image (queried, not hardcoded — it can
// shift with the base image). Cached to avoid repeated docker runs.
let cachedDeveloperIds: string | null = null;
export async function getDeveloperIds(image: string): Promise<string | null> {
  if (cachedDeveloperIds) return cachedDeveloperIds;
  const script = 'printf "%s:%s" "$(id -u developer)" "$(id -g developer)"';
  const r = await $`docker run --rm --entrypoint sh ${image} -c ${script}`.quiet().nothrow();
  if (r.exitCode !== 0) return null;
  cachedDeveloperIds = r.text().trim();
  return cachedDeveloperIds;
}

// Ensure a host cache dir exists and is owned by the container `developer`.
// The chown runs in a throwaway root container, so it needs no host sudo and,
// under rootless, lands on the correct subuid automatically. Returns false
// (rather than exiting) on failure, so callers can choose to hard-fail or
// continue with a warning.
export async function provisionCacheDir(hostDir: string): Promise<boolean> {
  const image = await findAnyCwwImage();
  if (!image) {
    error("No cww image found. Run 'cww build' first.");
    return false;
  }
  const ids = await getDeveloperIds(image);
  if (!ids || !ids.includes(":")) {
    error("Could not read 'developer' UID from the image.");
    return false;
  }
  fs.mkdirSync(hostDir, { recursive: true });
  const r = await $`docker run --rm --user 0 --entrypoint chown -v ${hostDir}:/c ${image} -R ${ids} /c`
    .nothrow();
  return r.exitCode === 0;
}
