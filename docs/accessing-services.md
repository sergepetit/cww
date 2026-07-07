---
type: guide
title: Accessing container services from a browser
description: How to reach a workspace's services from a browser — port publishing, why plain-http LAN origins break secure contexts, and SSH-forwarding to one fixed localhost origin
---

# Accessing container services from a browser

> Context: cww runs your app on a private per-workspace Docker network, and the agent works *inside*
> the container. But sometimes you want to open the app in a real browser — to click through a
> login, check the UI, take a screenshot. This note covers how to reach those services, why plain
> `http://<host-ip>:port` access breaks browser security features (Auth0/PKCE, Web Crypto,
> WebAuthn, `Secure` cookies), and how SSH-forwarding to a **fixed `localhost` port** solves both
> that and the "endless allowed-callback churn" you hit when running many workspaces. Auth0 is just
> the running example here — the same applies to any OAuth/OIDC provider, and to anything else that
> requires a secure context. See also [README](../README.md) → *Project-Specific Services*.

## Publish the port

By default cww services bind **no host ports** — that's what lets parallel workspaces coexist without
clashing. To reach the app from a browser, publish its port in the project's
`.cww/docker-compose.services.yml` using the **container-port-only** form:

```yaml
services:
  coder:             # or a dedicated app service
    ports:
      - "5174"       # container port only — NOT "5174:5174"
```

The bare `"5174"` (no host side) tells Docker to pick a **free host port** for each stack, so two
workspaces of the same project never collide on the host port — the whole point of running workspaces
in parallel. Pinning `"5174:5174"` instead forces a fixed host port, and a second parallel workspace
fails to start with *"port is already allocated"*.

`cww list` shows the assigned mapping in its `PORTS` column (`5174->49153`), and on the Docker host
itself the app is reachable at `http://localhost:49153`. From **another machine** you'd reach for
the host's LAN IP — and that's where browser security gets in the way.

## Why `http://<host-ip>:port` breaks logins

Browsers gate a set of powerful APIs behind a **secure context**. Only these origins qualify:

- `https://…` (any host), or
- a **loopback** origin — `http://localhost`, `http://127.0.0.1`, `http://[::1]`.

A plain-`http` origin on a LAN IP (`http://192.168.1.42:5174`) is **not** a secure context, so any
feature that depends on one fails:

- **Web Crypto** (`crypto.subtle`) is `undefined` → `auth0-spa-js must run on a secure origin`
  (Auth0's PKCE flow needs a SHA-256 digest). This is the most common one.
- Same class of failure for **WebAuthn/passkeys**, **Service Workers**, `Secure` **cookies**,
  clipboard, geolocation, etc.

On top of that, OAuth/OIDC providers (Auth0 and friends) pin **exact** redirect URLs and web
origins. `http://192.168.1.42:5174` and `http://localhost:5174` are *different origins* — each one
has to be registered separately in the provider.

## Fix: SSH-forward the port to your `localhost`

SSH local port-forwarding makes the remote service appear on **your** machine's `localhost` — a
secure context — with no TLS, no cert, and no change to the app. It runs **entirely on your
machine**; the only requirement on the Docker host is that you can SSH into it.

`cww tunnel-command <workspace>` prints the exact command, already filled in with the workspace's
(possibly ephemeral) host port and aimed at the stable **container** port on your side:

```bash
$ cww tunnel-command feature-auth
  ssh -N -L 5174:localhost:49153 you@docker-host

# run that on your laptop, then open http://localhost:5174
```

- `-L 5174:localhost:49153` — listen on **your** `localhost:5174` (the container port, always
  stable), tunnel over SSH, and connect to `localhost:49153` **on the Docker host** (whatever host
  port Docker assigned this stack). The `localhost` in the spec is resolved on the *remote* side, so
  the container port only has to be reachable from the host itself.
- `-N` — just forward, don't open a remote shell. Keep the session open while testing; Ctrl-C ends
  it. Add `-p <port>` if SSH is on a non-standard port. `cww tunnel-command` emits one `-L` per
  published port automatically (e.g. a separate API port).
- Container ports **below 1024** (e.g. an nginx on 80) are privileged on your machine, so ssh
  couldn't bind them locally; `cww tunnel-command` remaps those to a stable `+8000` local port
  (80 → 8080, 443 → 8443) and says so in its output.

Because the browser now sees `http://localhost:5174`:

- it's a **secure context** → Web Crypto / `auth0-spa-js` work with no HTTPS setup;
- you register **one** origin/callback (`http://localhost:5174`) in your provider, once.

## One fixed local origin for many workspaces

Running several workspaces at once, each publishes the same container port to a **different, Docker-
assigned host port** (workspace A → `49153`, workspace B → `49208`, …). If your browser hit those
host ports directly, you'd have to register every port in Auth0's allowed callbacks/origins — endless
churn every time you spin up a workspace.

Port-forwarding **decouples the two ports**, and `cww tunnel-command` always aims the **container**
port at your local side. So whichever workspace you tunnel to, you browse the *same* local origin:

```bash
# workspace A → whatever host port Docker gave it
cww tunnel-command workspace-a   # → ssh -N -L 5174:localhost:49153 you@docker-host
# workspace B → a different host port, but the SAME local 5174
cww tunnel-command workspace-b   # → ssh -N -L 5174:localhost:49208 you@docker-host
```

Either way you browse `http://localhost:5174`. **One origin, configured once**, no matter how many
workspaces you run or which host ports Docker picked. You view one at a time on that local port and
switch by restarting the tunnel.

The app's own origin-locked config (OAuth `redirect_uri`, CORS allowlist) can stay pinned to the
local (container) port in the committed compose too, since *through the tunnel* the app is always at
`http://localhost:5174` regardless of the per-workspace host port.

## The built-in browser's noVNC page rides the same tunnel

The [built-in headful browser](user-guide.md#built-in-headful-browser) publishes its noVNC page on
container port 7900 exactly this way (loopback-only, Docker-assigned host port), so it appears in
`cww list` and gets its own `-L 7900:localhost:<host-port>` line in `cww tunnel-command`
automatically. With the tunnel up, open:

```
http://localhost:7900/vnc.html?autoconnect=1&resize=scale
```

and you're looking at — and typing into — the very Chrome the agent drives. For an app the agent
runs inside its own container, this is often the *simpler* way to click through it: that browser
reaches it at `http://localhost:<port>` directly — a secure context, no published app port needed.
(An app running as a separate compose service is reachable by its compose hostname, e.g.
`http://web:5174`, but that origin is not a secure context — the secure-context caveats above apply
to it just like to a LAN IP.)

Security note: the VNC session has no password. That's the same trust model as every other
published dev port — the socket binds to the Docker host's loopback only, so remote access requires
the SSH tunnel.
