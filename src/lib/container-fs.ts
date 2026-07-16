// Generic host->container file plumbing, kept in its own leaf module so agent
// modules (src/agents/*) can use it without importing docker.ts — docker.ts
// imports the agent registry, which loads every agent module at import time,
// so an agent module importing docker.ts back would close a cycle (see the
// import-cycle guard in docs/agent-modularization-plan.md).

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Copy a host directory into a container path and hand its ownership to the
// in-container `developer` user. The copy is staged host-side with symlinks
// dereferenced, so a symlink such as `.cww/skills -> ~/.claude/skills`
// resolves to real files before docker cp (the symlink target does not exist
// inside the container). Returns false when the source can't be read.
// Copy host files/directories into a container and hand ownership of what was
// copied (only that — not the whole destination dir) to the in-container
// `developer` user. `dest` is treated as a directory when there are several
// sources or it ends with '/', otherwise as the target path itself; parents
// are created as needed. Returns the in-container path of each copy.
export async function copyIntoContainer(
  sources: string[],
  container: string,
  dest: string,
): Promise<string[]> {
  const asDir =
    sources.length > 1 || dest.endsWith("/") || (await isContainerDir(container, dest));
  const dir = asDir ? dest.replace(/\/+$/, "") || "/" : path.posix.dirname(dest);
  await $`docker exec ${container} mkdir -p ${dir}`;
  const copied: string[] = [];
  for (const src of sources) {
    const target = asDir ? path.posix.join(dir, path.basename(src)) : dest;
    // -L dereferences symlinked sources, matching copyDirIntoContainer's
    // staging behavior (the link target does not exist inside the container).
    await $`docker cp -L ${src} ${container}:${target}`.quiet();
    await $`docker exec -u root ${container} chown -R developer:developer ${target}`
      .quiet()
      .nothrow();
    copied.push(target);
  }
  return copied;
}

// Copy container paths out to the host. `dest` is treated as a directory when
// there are several sources or it ends with '/'. Returns the host path of
// each copy. No chown: docker cp writes host files as the invoking user.
export async function copyFromContainer(
  container: string,
  sources: string[],
  dest: string,
): Promise<string[]> {
  const asDir = sources.length > 1 || dest.endsWith("/") || isHostDir(dest);
  const copied: string[] = [];
  for (const src of sources) {
    const target = asDir ? path.join(dest, path.posix.basename(src)) : dest;
    await $`docker cp -L ${container}:${src} ${target}`.quiet();
    copied.push(target);
  }
  return copied;
}

async function isContainerDir(container: string, p: string): Promise<boolean> {
  const res = await $`docker exec ${container} test -d ${p}`.quiet().nothrow();
  return res.exitCode === 0;
}

function isHostDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function copyDirIntoContainer(
  src: string,
  container: string,
  dest: string,
): Promise<boolean> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cww-assets-"));
  try {
    try {
      fs.cpSync(src, stage, { recursive: true, dereference: true });
    } catch {
      return false;
    }
    await $`docker exec ${container} mkdir -p ${dest}`;
    await $`docker cp ${stage}/. ${container}:${dest}/`.quiet();
    await $`docker exec -u root ${container} chown -R developer:developer ${dest}`
      .quiet()
      .nothrow();
    return true;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
