// User-maintained pass-through env for the app's own services — the one
// channel whose contents reach a container verbatim (agent credentials do not
// travel here; see env-refresh.ts). Three host-side layers, least- to
// most-specific:
//   ~/.cww/services.env                        every workspace on this machine
//   ~/.cww/services/<project>.env              every workspace of this project
//   ~/.cww/services/<project>/<workspace>.env  just this workspace
// 'cww create' renders all three into the compose env_file list in that order,
// so a more specific layer overrides a broader one (compose: later wins), and
// the task-dir env comes last so a services file can never shadow a
// credential. Host-side only, so a value can be secret without being
// committed — the in-repo .cww/docker-compose.services.yml 'environment:'
// entries stay the route for shareable, non-secret values.
//
// The <project>.env file and the <project>/ directory coexist without
// ambiguity, unlike a flat <project>-<workspace>.env, which would collide with
// a project literally named that (the same clash ~/.cww/tasks already carries).
//
// Names are sanitized exactly as container and task names are, so the project
// and workspace a user typed map to one predictable path.

import os from "node:os";
import path from "node:path";
import { sanitizeName } from "./naming";

// Machine-wide layer: applies to every workspace of every project.
export function globalServicesEnvFile(home = os.homedir()): string {
  return path.join(home, ".cww", "services.env");
}

// Project layer: applies to every workspace created from this project.
export function projectServicesEnvFile(project: string, home = os.homedir()): string {
  return path.join(home, ".cww", "services", `${sanitizeName(project)}.env`);
}

// Workspace layer: applies to one workspace only.
export function workspaceServicesEnvFile(
  project: string,
  workspace: string,
  home = os.homedir(),
): string {
  return path.join(
    home,
    ".cww",
    "services",
    sanitizeName(project),
    `${sanitizeName(workspace)}.env`,
  );
}

// The layers a workspace gets, ordered least- to most-specific. Paths are
// returned whether or not they exist — compose's `required: false` handles the
// missing ones — so the precedence order is defined once, here.
export function servicesEnvFiles(
  project: string,
  workspace: string,
  home = os.homedir(),
): string[] {
  return [
    globalServicesEnvFile(home),
    projectServicesEnvFile(project, home),
    workspaceServicesEnvFile(project, workspace, home),
  ];
}
