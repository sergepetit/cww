# OpenCode quirks inside a cww workspace

Known rough edges of *this* CLI in *this* environment, written for you, the
agent. Unlike the bundled user docs, everything here happens in the workspace.

## After any dependency install, check whether your code intelligence is alive

It can be dead **silently** — nothing will announce it, the install succeeds,
the app runs, and every type error you introduce goes unnoticed by both of you.
There are two different causes with two different remedies, so run the check
before deciding anything.

**Run this, do not reason about it:**

```sh
cd /workspace && node -e "console.log(require.resolve('typescript/lib/tsserver.js'))"
```

That is the exact resolution OpenCode performs — from the **workspace root**,
not from the file you are editing (verified against OpenCode 1.18.4).

**If it prints a path** and the TUI's LSP panel lists a server after a
TypeScript file has been read, you are fine. Say nothing about any of this.

**If it fails**, you are type-blind, and which remedy applies depends on why:

- **Nothing was installed when your session started.** A fresh cww workspace is
  a cold clone with no `node_modules` at all, and a failed attach is never
  retried — so installing afterwards does not switch the server on. **Tell the
  user to restart you**: exit and relaunch OpenCode. Say why.
- **`typescript` is installed, but not at the workspace root.** Check with
  `ls /workspace/node_modules/typescript` versus e.g.
  `ls /workspace/packages/*/node_modules/typescript`. This is a monorepo whose
  package keeps its own copy, and **restarting will not help** — the resolution
  fails identically every session. Tell the user it needs `typescript` hoisted
  to the root install, or a committed `opencode.json` that points a language
  server at the subdirectory's compiler explicitly. Do not promise a restart
  will fix it.

Bun projects have a sharper version of the first case: `bun run` auto-installs
into `~/.bun/install/cache` and can start an app **without ever creating
`node_modules`**, in which case the check above can never succeed. Run an
explicit `bun install` so a real `node_modules` exists, *then* ask to be
restarted.

The first case is OpenCode's own session lifecycle, not something cww does — it
happens on a laptop too if you launch before installing. cww just guarantees you
meet it, because every workspace starts from a cold clone.

## TypeScript 7 gets no code intelligence at all — restarting will not help

This is a **separate** problem from the one above; do not confuse the two, and
do not offer a restart as the remedy.

OpenCode boots the workspace root's `typescript/lib/tsserver.js`. TypeScript 7 —
the Go rewrite, and what a bare `npm install typescript` installs today — ships
no such file, because its language server is native and speaks LSP directly.
There is no server to attach at any point in the session, so restarting
achieves nothing.

If this repo is on TypeScript 7 and the user expects diagnostics, tell them the
real options: pin `typescript` to `^6` (the maintained JS-based line), or
accept no code intelligence until OpenCode ships native support for the Go
toolchain.
