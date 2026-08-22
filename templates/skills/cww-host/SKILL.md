---
name: cww
description: How to drive cww (Coder Workspace Workflow) from the user's own machine — setting a repo up for it, configuring the repo's .cww/ services and image, and creating, inspecting, and recycling workspaces. Use when the user wants to work on a repo in a disposable container, mentions cww or a "cww workspace", asks to sandbox an agent or a project, asks why a workspace has no services / no database / can't reach something, or asks how to reach an app running inside one. This is the HOST side: you are on the user's machine and can run the cww CLI here. It does not describe being inside a workspace — the workspace has its own cww skill for that.
---

# Driving cww from the host

**cww** (Coder Workspace Workflow) gives a repo disposable, full-stack
development environments: one container running a coding agent, plus sibling
containers for the project's services, created from a fresh clone. The user
installed it on this machine, and you are on that machine — so unlike the
skill that ships *inside* a workspace, you can actually run `cww` here.

That is the whole point of this file: what you may run, what you must hand
to the user instead, and how to set a repo up so the first `cww create`
produces something that works.

## What you may and may not run

**Run freely** — read-only or cheap and reversible:

| Command | What it gives you |
|---|---|
| `cww list` | every workspace, its state, and its published ports |
| `cww tunnel-command <ws>` | the SSH command that reaches a workspace's app on a fixed localhost origin |
| `cww cp <src> <dst>` | copy files host ↔ workspace, scp-style (`ws:path`) |
| `cww export-skill [name]` | list host skills / share one with this project and its running workspaces |
| `cww start <ws>` / `cww stop <ws>` | resume or pause a workspace |
| `cww build [agent]` | rebuild an agent image |
| `cww create <path> <ws> --no-attach` | create a workspace without taking over the terminal |

**Never run — hand these to the user:**

- **`cww teardown`.** It is destructive and pushes nothing: the container,
  the service containers, the volumes, and the metadata all go. Anything not
  pushed is gone. Say what it will destroy, remind them to push first, and
  let them type it.
- **`cww init` and `cww auth`.** Both prompt on a TTY and both take secrets —
  a fine-grained PAT for the repo, or the agent's own token. `cww init`
  validates the credential with `git ls-remote` before storing it in
  `~/.cww/credentials`. Print the exact command for the user to run, then
  read the result once they have.
- **`cww attach`.** It hands the terminal to a tmux session; it is for the
  user, not for you.

Never ask the user to paste a token or key into a file you write, and never
echo one back.

## Setting a repo up, in order

For a repo that has never seen cww:

1. **Check the machine.** Docker reachable (`docker info`), `cww` on PATH.
2. **The agent's credential** — `cww auth <agent>` (user runs it). Skipped if
   they already use that agent elsewhere; it is machine-wide, not per-repo.
3. **`cww init`** in the repo (user runs it). Picks the clone URL workspaces
   will use and stores the scoped git credential. Also preflights docker, the
   agent auth, and the agent image, so its output is the best diagnostic you
   have — ask for it when something later fails.
4. **Author `.cww/`** — your part. See below.
5. **`cww create <ws>`** — the first workspace. `--no-attach` if you are
   driving it; plain if the user wants to land in the agent immediately.

Steps 2 and 3 are one-time per machine and per repo respectively; 4 and 5 are
where the actual work is.

## Configuring the repo (`.cww/`)

This is the part you are best placed to do: the repo usually already contains
the raw material — a `docker-compose.yml`, a CI config, migration and seed
tooling — and turning it into a `.cww/` folder is mechanical once you know
the rules.

**Read `references/cww-project-config.md` before writing any of these
files.** It is the single source of truth for what each one does:
`docker-compose.services.yml` (and the two cww-specific rules — container-port
-only publishing, and `${HOME}/.cww/cache/...` mounts provisioned with
`cww cache`), `reset.sh`, `Dockerfile`, `hosts`, the personal
`skills/`/`commands/`/`agents/` folders, and which values must stay out of
the repo entirely.

Two host-specific notes on top of it:

- **You can write the host-side env layers**, which the in-workspace agent
  cannot even see: `~/.cww/services.env`,
  `~/.cww/services/<project>.env`, `~/.cww/services/<project>/<workspace>.env`
  (narrower wins). That is where a credential or an internal endpoint goes —
  never into the repo. Ask the user for the value; do not invent one, and do
  not copy one out of their shell history or another project's files.
- **Applying a change is one step here**, not four. Edit the checkout and run
  the applying command: services / hosts / env / `Dockerfile` need
  `cww teardown NAME && cww create NAME` (destructive — so it is the user's
  to run), `reset.sh` needs `cww reset NAME`, credential or URL changes need
  `cww init`.

Config you generate is something this machine will *run*. Show it to the user
before it is committed.

## Answering "where is my app?"

Workspace ports are published on this machine on **loopback only, with
Docker-assigned numbers** — never a fixed port, because parallel workspaces
of the same repo would collide.

- `cww list` shows the actual mapping.
- A plain `http://localhost:<port>` works for simple apps.
- Anything needing a **secure context** (service workers, WebAuthn, some
  OAuth callbacks) or a **fixed origin** (registered redirect URIs) needs
  `cww tunnel-command <ws>`, which prints an SSH command binding the app to
  one stable localhost port. `references/accessing-services.md` explains why.

Inside the workspace, services are reached by **hostname**
(`postgres:5432`) — so a connection string that works in here is usually
wrong in there, and vice versa.

## Recycling, not repairing

Workspaces are disposable by design. When one is in a bad state — wrong
image, broken dependency tree, half-applied config — the normal answer is to
recreate it, not to debug it in place. The exception is anything unpushed:
check with the user first, and note that `cww cp` can rescue a file from a
workspace whose git state is a mess.

## References

- `references/cww-project-config.md` — every file in a repo's `.cww/`, the
  host-side env layers, and how a change to either takes effect.
- `references/user-guide.md` — every command and option, authentication, the
  Docker image, project services, the built-in browser, dependency caches,
  configuration, troubleshooting.
- `references/git-strategy.md` — the in-container clone, the scoped
  credential, attribution, and example git workflows.
- `references/accessing-services.md` — reaching a workspace's services from a
  real browser: port publishing, secure contexts, SSH-forwarding.
