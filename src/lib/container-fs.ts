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
