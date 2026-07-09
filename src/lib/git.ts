// Host-side git queries.

import { $ } from "bun";

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await $`git -C ${dir} rev-parse --git-dir`.quiet().nothrow();
  return r.exitCode === 0;
}

// Root of the git repository containing dir, or null when outside a repo.
export async function getGitRoot(dir: string): Promise<string | null> {
  const r = await $`git -C ${dir} rev-parse --show-toplevel`.quiet().nothrow();
  return r.exitCode === 0 ? r.text().trim() : null;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await $`git -C ${repoPath} show-ref --verify --quiet refs/heads/${branch}`.quiet().nothrow();
  return r.exitCode === 0;
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  return (await $`git -C ${repoPath} branch --show-current`.quiet()).text().trim();
}

export async function getCurrentCommit(repoPath: string): Promise<string> {
  return (await $`git -C ${repoPath} rev-parse HEAD`.quiet()).text().trim();
}
