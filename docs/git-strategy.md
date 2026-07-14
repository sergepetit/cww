---
type: reference
title: cww Git Strategy
description: The two git mechanics cww owns — clone-in-container and the developer's own scoped credential — plus attribution and example workflows
---

# cww Git Strategy

> Context: cww provisions a workspace and clones your repo into it; **what you do with git inside is entirely yours.** cww imposes no branching model, runs no rebase, and has no push/PR command. This doc explains the two mechanics cww *does* own — how the clone and the credential work — and then sketches example workflows you're free to adopt (or ignore).

## What cww does and doesn't do

**cww owns two things about git, both at workspace-creation time:**
1. It **clones the real repository inside the container** (not a host worktree).
2. It injects the **developer's own scoped credential and identity** so clone/commit/push work as the human.

**cww does *not*:** cut a mandated branch name, rebase, squash, force-push, or open a PR. Inside the workspace you have a normal clone with working credentials — branch, rebase, stack, switch, push, or open PRs however your team works. Run git yourself with `cww shell <name>`, or let the agent do it.

## Decision 1: clone the repo inside the container

cww **clones the repository inside the container** instead of mounting a host git worktree.

`git worktree add` writes a `.git` *file* pointing at a host path (`gitdir: /host/path/.git/worktrees/<branch>`) the container can't see, so in-container git breaks. A normal clone instead has a self-contained `.git` *directory* with repo-relative internal references — the agent (or you, via `cww shell`) can `clone`, `commit`, `diff`, `log`, and `push` from inside. Isolation comes from a dedicated clone per workspace, not a worktree per task.

At `cww create`, the container clones the host's `origin` remote (or the one you pick with `--remote <name>`) and checks out a branch: the one you're on at the host by default, or `--branch <ref>` if you pass it (a name that doesn't exist upstream is created as a fresh branch). That's the *only* branch decision cww makes, and it's just a convenience starting point — switch or create branches freely afterward.

## Decision 2: clone the real repo with the developer's own credential

There is **no fork and no bot account**. The container's `origin` is the **real repository**. It's cloned with the developer's own credential, and any push the agent or developer makes goes to the real repo.

> Use a tightly scoped credential — a fine-grained PAT limited to the one repository — and enable branch protection (required review, no force-push) on branches you care about before letting an agent work unattended. cww cannot check or enforce either; the platform's gate is what keeps protected branches safe.

## How the clone and credential are wired

1. **`cww create <name>`** starts the container and passes it the repo URL, the branch to check out, and the developer's git identity + credential (from their account env — see Credentials).
2. **Container** clones the repo into `/workspace` (its own filesystem — no host mount, no volume) and checks out the requested branch.
3. **Inside the workspace** the agent (or you, via `cww shell`) commits — authored as the developer (see Attribution) — and pushes with plain git whenever it makes sense. cww is not involved in this step and enforces nothing.
4. **PR** is opened however you normally do (the platform UI, `gh`/`glab`, a compare link). cww provides no PR command.

cww records the workspace name, the branch checked out at create, and the repo URL in `session.json`; that session metadata and the generated compose file live in a host dir (`~/.cww/tasks/<project>-<workspace>/`).

## Example workflows (pick one, or don't)

cww is git-flow agnostic, so these are illustrations — not requirements. A workspace is durable: set it up once and run many of these over its life without tearing it down.

- **Branch-per-task + PR.** Create a branch, commit, `git push -u origin <branch>`, open a PR from the compare link, merge, delete the branch. Repeat in the same workspace for the next task.
- **Rebase-before-PR.** Before opening the PR: `git fetch origin && git rebase origin/<base>` so the PR shows only your changes against current upstream, then `git push --force-with-lease`. Do this only if your team prefers linear history — cww won't do it for you.
- **Trunk-based.** Small commits straight onto a short-lived branch off the default; merge fast, keep the workspace warm.
- **Stacked branches.** Build a stack of dependent branches in one workspace and push them as a chain (or with your stacking tool of choice).
- **Long-lived integration workspace.** Keep a workspace around as a warm, seeded environment; cut throwaway branches for experiments and only push the ones worth keeping.

Whatever you choose, the credential is already in place, so `git push` just works — see below.

## Authorship & attribution

The container sets its git identity to the **developer**, captured at `cww create` from their host `git config`:

```
GIT_AUTHOR_NAME  / GIT_AUTHOR_EMAIL      = the dev
GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL = the dev
```

Since the push credential is also the developer's, both the commit author and the pusher are the human — blame, log, and per-line attribution all show the developer.

**Use the dev's account-registered email** (verified or `…@users.noreply.github.com`): GitHub/GitLab/Forgejo match commits to a profile by author email, giving avatar linking and contribution-graph credit once merged.

## Credentials

- **Container credential = the developer's own git token**, scoped as tightly as the platform allows — a **fine-grained PAT limited to the single repository**, ideally short-lived (e.g. a GitHub App installation token). Injected via an env-reading credential helper so it never lands in `.git/config` or on disk:
  ```
  git config --global credential.helper '!f(){ echo "username=${CWW_GIT_USER:-x-access-token}"; echo "password=$CWW_GIT_TOKEN"; };f'
  ```
  `CWW_GIT_USER` is the platform login — **required** for Forgejo/Gitea (which reject `x-access-token`); the `x-access-token` default suits GitHub App / fine-grained tokens.
- **SSH remotes are rewritten to HTTPS** (`normalize_git_url`) because SSH keys are deliberately not mounted into the container. If your host is on plain http or a non-443 port (common for self-hosted Forgejo/Gitea), set `CWW_REPO_URL` to the exact clone URL in a per-project `<repo>/.cww/env`.
- **Per-user isolation comes from the OS:** each developer runs cww under their own account on the box, with `CWW_GIT_TOKEN` in their own environment (`~/.cww/env`, mode 600). No shared token, no cross-user access.
- **No signing key** in the container.

## Disk & performance

- Every workspace is a full clone — fully isolated, no shared mutable state. N parallel workspaces = N clones.
- Cost is a network fetch + disk per workspace.

