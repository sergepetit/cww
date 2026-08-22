// Workspace lifecycle operations: the sequences that act on a whole workspace
// rather than on one docker object. Kept out of docker.ts so that module can
// stay pure Docker/compose plumbing — this is the layer that knows a workspace
// is a compose stack PLUS refreshed secrets PLUS an up-to-date built-in skill,
// and so the only one that needs the agent registry.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { refreshWorkspaceSkill } from "../agents/registry";
import { taskCompose } from "./docker";
import { hardenRefreshFile, refreshWorkspaceSecrets } from "./env-refresh";
import { info } from "./ui";

// Bring a stopped workspace back up ('cww start', and on the way into
// attach/shell). 'cww stop' stops the whole compose stack, so restart the
// whole stack — otherwise the agent comes back up with its services (DB,
// etc.) still down. Fall back to the agent container alone when the compose
// files are gone (e.g. the pattern-matched path, with no task dir). Current
// secrets are copied in first, so the restarted agent picks up tokens
// rotated since the container was created (see env-refresh.ts); the built-in
// cww skill is re-synced once the container is up, so an upgraded cww reaches
// existing workspaces too (see refreshWorkspaceSkill).
export async function startTaskStack(taskDir: string | null, container: string): Promise<void> {
  await refreshWorkspaceSecrets(taskDir, container);
  if (taskDir && fs.existsSync(path.join(taskDir, "docker-compose.yml"))) {
    info("Stack is stopped. Starting container and services...");
    if ((await taskCompose(taskDir, ["start"])) !== 0) {
      await $`docker start ${container}`;
    }
  } else {
    info("Container is stopped. Starting...");
    await $`docker start ${container}`;
  }
  await hardenRefreshFile(container);
  // Best-effort: a skill that can't be re-copied must never keep the user out
  // of a workspace.
  try {
    await refreshWorkspaceSkill(taskDir, container);
  } catch {
    // ignore
  }
}
