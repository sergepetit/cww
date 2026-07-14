// Name derivation and URL normalization — the pure core of the old
// scripts/lib/common.sh.

import os from "node:os";
import path from "node:path";

// Sanitize a workspace/project name for use in container/directory names.
export function sanitizeName(name: string): string {
  return name
    .replaceAll("/", "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

// Container name from project and workspace name.
export function getContainerName(project: string, workspace: string): string {
  return `cww-${sanitizeName(project)}-${sanitizeName(workspace)}`;
}

// The kernel rejects hostnames over 64 bytes (sethostname EINVAL), and DNS
// labels cap at 63, so a long workspace name must not flow into the compose
// hostname: verbatim. It is cosmetic anyway (the prompt shows CWW_WORKSPACE,
// services address the container by compose service name), so truncate and
// strip any dash the cut leaves dangling.
export function containerHostname(containerName: string): string {
  return containerName.slice(0, 63).replace(/-+$/, "");
}

// Root directory holding per-task host metadata (session.json + compose files).
// The clone itself lives inside the container, not here.
export function getTasksRoot(): string {
  return path.join(os.homedir(), ".cww", "tasks");
}

// Stable task name from project + workspace name. Namespaced by project because
// ~/.cww/tasks is global: two projects can share a workspace name.
export function getTaskName(project: string, workspace: string): string {
  return `${sanitizeName(project)}-${sanitizeName(workspace)}`;
}

// Host metadata directory for a specific workspace.
export function getTaskDir(project: string, workspace: string): string {
  return path.join(getTasksRoot(), getTaskName(project, workspace));
}

// Normalize a git remote URL to an https form the in-container credential
// helper can authenticate. SSH remotes are rewritten because we deliberately
// don't mount SSH keys into the container. (Self-hosted hosts on http / a
// non-443 port: the setup flow lets you type the exact URL, stored per
// project in ~/.cww/config.json.)
export function normalizeGitUrl(url: string): string {
  // ssh://git@host[:port]/path -> https://host/path. The SSH port is dropped:
  // it is not the web port (web is assumed on default 443).
  const sshForm = url.match(/^ssh:\/\/git@([^/:]+)(?::[0-9]+)?\/(.*)$/);
  if (sshForm) return `https://${sshForm[1]}/${sshForm[2]}`;
  // scp-style git@host:org/repo.git -> https://host/org/repo.git
  const scpForm = url.match(/^git@([^:]+):(.*)$/);
  if (scpForm) return `https://${scpForm[1]}/${scpForm[2]}`;
  return url;
}
