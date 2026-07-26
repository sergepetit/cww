---
type: exploration
title: OpenCode TypeScript LSP — Root Resolution, TS 7, and Why cww Waits for Upstream
description: The three ways an OpenCode workspace ends up with no TypeScript intelligence — root resolution, the fresh-workspace race, TypeScript 7 — with the measured evidence for each, and why cww deliberately ships no workaround
created: 2026-07-22
timestamp: 2026-07-26
tags: [opencode, lsp, typescript]
---

# OpenCode TypeScript LSP — Root Resolution, TS 7, and Why cww Waits for Upstream

A record of a decision to **do nothing**, so it doesn't get silently re-litigated.

## Symptom

An OpenCode workspace on a repo using TypeScript 7 gets no code intelligence at all. There is no error, no log line, no warning — the TUI sidebar simply keeps saying *"LSPs will activate as files are read"* after a `.ts` file has been read. It is indistinguishable from "this isn't a TypeScript project."

## Check these first — the two more common causes

TypeScript 7 is the *rarest* of the three ways this symptom occurs. Rule out
the other two before reading further; both are stated for users in the [user
guide's LSP section](user-guide.md#typescript-code-intelligence-lsp) and for the
in-workspace agent in `templates/agent-troubleshooting/opencode.md`, so this doc
records only the evidence behind them.

- **Root resolution.** The compiler is resolved from the *workspace root*, not
  from the edited file, so a monorepo package with its own `node_modules` gets
  nothing. Measured 2026-07-26 (details under [Mechanism](#mechanism)).
- **The fresh-workspace race.** Neither a cww defect nor avoidable by cww: it is
  OpenCode's session lifecycle, and a disposable always-cold-clone workspace
  just guarantees you meet it every time instead of once in a blue moon.

Race, observed on **OpenCode 1.18.4** (2026-07-22), in a freshly recreated
smoketest workspace:

```
12:13:08.930  opencode session starts (container create)
12:14:03      node_modules/typescript installed   <- 55 seconds later
```

That session never attached a server, and installing afterwards did not revive
it. A second session, started in the same container against the same files,
reported `Type 'string' is not assignable to type 'number'` immediately.

**Scope: OpenCode only — Claude Code was tested and is not affected.** Same
repo, same cold clone, dependencies installed 83 seconds into the session
(container up 14:24:37, `node_modules` at 14:26:00 on 2026-07-22): Claude still
reported `Type 'string' is not assignable to type 'number' [2322]`, and the
`typescript-language-server` process only appeared at that point rather than at
launch. It resolves the server when it needs diagnostics, not once at startup,
so a `node_modules` arriving mid-session is picked up normally. Copilot and Vibe
workspaces ship no LSP at all.

That is why `templates/agent-troubleshooting/` carries an `opencode.md` and no
`claude.md`: the warning would be false for Claude.

Written up for users in the user guide's LSP section, and for the in-workspace
agent in `templates/agent-troubleshooting/opencode.md`, which it reads and
answers from when asked why code intelligence is missing. It does *not*
reliably raise this unprompted — see [backlog.md](backlog.md).

## Mechanism

TypeScript's editor integration was historically **tsserver** — a Node program at `typescript/lib/tsserver.js` speaking Microsoft's own protocol, not LSP. `typescript-language-server` is the adapter that translates LSP to it. It carries no compiler; it boots the copy it is pointed at.

OpenCode's built-in server does exactly that, and gives up silently at either step:

```js
async spawn($, Y) {                     // $ = root (lockfile-derived; only the server's cwd)
  let Z = v$.resolve("typescript/lib/tsserver.js", Y.directory); if (!Z) return;
  let X = await w$.which("typescript-language-server");          if (!X) return;
  return { process: q(X, ["--stdio"], ...), initialization: { tsserver: { path: Z } } }
}
// v$.resolve(name, dir) = createRequire(join(dir, "package.json")).resolve(name)
```

Two things in there are easy to get wrong, and both were verified live on 2026-07-26 (OpenCode 1.18.4):

- **`Y.directory` is the *project* directory, not `$`.** The lockfile-derived `root()` only sets the server's cwd; resolution is anchored at the workspace root. So `typescript` must be resolvable from `/workspace` — lockfiles are irrelevant to it. Tested: package in `packages/app` with no lockfile → no LSP; same plus a lockfile in `packages/app` → still no LSP; same code with `typescript` hoisted to `/workspace/node_modules` → LSP attaches. This is the corrected cause of [opencode#18694](https://github.com/anomalyco/opencode/issues/18694) / [#16335](https://github.com/anomalyco/opencode/issues/16335) ("not used when `package.json` is in a subdirectory").
- **`w$.which` is not a PATH lookup.** It is OpenCode's package *fetcher*: it downloads into `~/.cache/opencode/packages` and the built-in `typescript` entry never consults `PATH` — unlike `vue` and `pyright`, which try `R(...)` on PATH first and honour `disableLspDownload`. Tested: every attaching run spawned the fetched copy while an identical `typescript-language-server` 5.3.0 sat baked at `/usr/bin`; deleting the cache made it re-download rather than fall back; with the npm registry blackholed *and* npm/bun caches cleared, no LSP at all. The baked binary is therefore dead weight for the built-in path and load-bearing only for a config-supplied `command` — which is the only registry-free path to TypeScript intelligence, and why the image still bakes it.

TypeScript 7 is the Go rewrite. Its npm package is a launcher around a per-platform native binary and **ships no `tsserver.js` at all** — the language server is built into the binary and speaks LSP natively, via `tsc --lsp --stdio` (verified working; returns a full initialize response). So the adapter has nothing to attach to, and the `if (!Z) return` branch fires.

| Line | Editor entry point | Works with the baked adapter? |
|---|---|---|
| 5.x | `lib/tsserver.js` | yes |
| 6.x — final JS-based line, maintained | `lib/tsserver.js` | yes (verified against 6.0.3) |
| 7.x — Go rewrite | `tsc --lsp --stdio` | **no** |

Note that `npm install typescript` resolves to 7.x, so this is the default path for a new project, not an edge case.

## Why cww ships no workaround

A shim could pick the right server per project. We deliberately don't, because:

(The `typescript-pinned` override documented in the user guide is not a cww shim — it is a per-repo escape hatch a user opts into, carrying the same retire-it-when-upstream-lands caveat. cww itself ships nothing.)

- **`opencode-ai` is installed unpinned** in `src/agents/opencode/Dockerfile`. Whenever upstream fixes this, the next `cww build` picks it up with no cww change at all.
- **A workaround would not be inert once upstream lands.** Config entries merge over built-ins by id, and supplying a `command` replaces the built-in's `enabled` predicate — so an override would *shadow* a corrected built-in, and a separate server id would mean two servers attached to the same files. Either way someone has to notice and retire it, in a repo where nothing will remind them.
- **The ecosystem will adopt TS 7 slowly.** Its package exports no classic compiler API (`"."` maps to `lib/version.cjs`; only `unstable/*` entry points exist), so `ts-loader`, `typescript-eslint`, `ts-jest` and similar cannot consume it yet. Real-world TS 7 usage will lag the npm dist-tag by a wide margin.

The cost of waiting is one silent failure mode, which this doc and the user-guide note convert into a quick diagnosis.

## Revisit trigger

- [opencode#12522 — typescript-go LSP first-party support](https://github.com/anomalyco/opencode/issues/12522) closing, or
- [opencode#12492](https://github.com/anomalyco/opencode/pull/12492) landing — it gated tsgo behind `OPENCODE_EXPERIMENTAL_TSGO=true`, so adoption would likely be one env var rather than a shim.

History as of 2026-07-22: the issue has been open since 2026-02-06 with an assignee but no maintainer response; the PR received no review and was auto-closed by a stale bot on 2026-04-24. This is against a release cadence of several versions per week — so the feature is not imminent, but pressure will rise as TS 7 adoption grows.

Also worth checking when revisiting, as both affect the TS ≤6 path we *do* ship:

- [opencode#21791](https://github.com/anomalyco/opencode/issues/21791) — `typescript-language-server` v5 deprecated CLI flags (not reproduced against our baked 5.3.0 + TS 6.0.3).
- [opencode#18694](https://github.com/anomalyco/opencode/issues/18694) / [#16335](https://github.com/anomalyco/opencode/issues/16335) — root resolution in monorepos. **No longer just "worth checking": reproduced, with the real cause identified under [Mechanism](#mechanism).** If a fix lands, the user-side `typescript-pinned` override documented in the user guide must be retired, or it will shadow the corrected built-in.

## Why cww-smoketest pins TypeScript 6

`cww-smoketest` declares `"typescript": "^6.0.0"` **so the LSP feature stays testable** — not because 6 is what a user should prefer. Don't bump it to 7 to "modernize": that would silently disable the very thing the repo exists to exercise. A caret range on 6 cannot cross to 7, so the pin is self-limiting.

The repo is bun + Vite, and neither loads the `typescript` package — it transpiles via esbuild and bun's own stripper. So the dependency is inert with respect to the build and exists purely to give the checker and the LSP an engine.
