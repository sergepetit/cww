---
name: verify
description: How to verify cww CLI changes end-to-end without touching the developer's real ~/.cww or workspaces — isolated HOME, real Docker daemon, scratch repo, teardown after.
---

# Verifying cww changes

The surface is the `cww` CLI (`bun src/cli.ts <command>`); no build step.

## Isolated environment

Never run against the real `~/.cww` — create a fake HOME and a scratch repo:

```bash
S=$(mktemp -d)
mkdir -p $S/home/.cww $S/repo
(cd $S/repo && git init -q && git config user.name V && git config user.email v@test.invalid \
  && echo hi > f && git add . && git commit -qm init \
  && git remote add origin https://cww-verify.invalid/org/repo.git)
# Seed config.json (keyed by the repo's realpath) + env + credentials to skip
# the interactive setup flow; use .invalid hosts so nothing real is reached.
```

Key gotcha: overriding HOME breaks the Docker CLI's context (it lives in
`~/.docker`), so every docker call fails on the default socket. Pin the real
daemon explicitly:

```bash
export DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}' $(docker context show))
```

## Driving

- `HOME=$S/home bun src/cli.ts create $S/repo w1 --no-attach </dev/null` runs
  a full create against real Docker. The in-container clone of the `.invalid`
  URL fails fast — expected; the container still comes up (tmux shows the
  failure log), which is enough to inspect everything.
- Error paths are cheap: `</dev/null` makes create/auth die at any prompt
  instead of hanging, so bad flags and missing keys can be probed non-TTY.
- Inspect: `docker exec <container> env`, the generated files under
  `$S/home/.cww/tasks/<project>-<ws>/` (session.json, env, compose files).
  Note `docker exec` shows the container's create-time env; values delivered
  by the start-time secret refresh only appear in entrypoint-descended
  processes — check `tr '\0' '\n' < /proc/$(pgrep -o tmux)/environ`.
- Piping a value into `cww auth` works: `echo tok | HOME=$S/home bun src/cli.ts auth ...`.

## Cleanup

`HOME=$S/home bun src/cli.ts teardown w1 -y`, then confirm with
`docker ps -a | grep <project>`. The developer's own `cww-*` containers may be
running — never touch containers you didn't create.

## Windows

Windows changes are verified on a real Windows box over ssh (so far a
Windows 10 machine with Docker Desktop, `me@win-box` below). Its default ssh
shell is cmd.exe, which mangles inline PowerShell, so pass scripts
base64-encoded:

```bash
ps='cd $env:USERPROFILE\cww-dev; bun test'
ssh me@win-box "powershell -NoProfile -EncodedCommand $(printf '%s' "$ps" | iconv -t UTF-16LE | base64)"
```

Wrap native commands in `cmd /c "... 2>&1"`: PowerShell 5.1 turns native
stderr into CLIXML noise. Sync the working tree without committing (Windows
ships bsdtar):

```bash
ssh me@win-box '(if exist cww-dev rmdir /s /q cww-dev) & mkdir cww-dev'
git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar czf - --null -T - \
  | ssh me@win-box 'tar xzf - -C cww-dev'
```

- Isolation: `os.homedir()` reads `USERPROFILE` on Windows, not `HOME`, so a
  fake home needs `$env:USERPROFILE` (and `$env:HOME`) pointed at it. On a
  dedicated test box, using its real `~/.cww` is fine.
- Non-TTY create: seed `%USERPROFILE%\.cww\config.json` with the repo's
  `C:\...` path as key, set a repo-local git identity, and use a public repo
  URL so the in-container clone succeeds.
- Attach, shell, secret prompts and tab completion need a real console:
  ask the developer to check those at the machine.
