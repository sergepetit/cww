#!/bin/bash
# cww browser stack: a headful browser (Google Chrome on amd64, Chromium on
# arm64) on a virtual display, so the agent and the developer share ONE
# browser. The agent drives it over CDP
# (127.0.0.1:9222, loopback only — never published); the developer watches and
# takes over (logins, 2FA, captchas) via noVNC on container port 7900, which
# cww publishes to a loopback-only ephemeral host port.
#
# Launched in the background by entrypoint.sh unless CWW_BROWSER=off. Helpers
# (Xvfb/x11vnc/websockify) are started once, unsupervised: they are stable, and
# a dead helper means a broken stack — recover it by killing what's left of the
# old stack and rerunning this script. The browser itself runs in a restart
# loop — closing the last window from noVNC should not end browser automation
# for good. A pidfile guards against a concurrent second copy of the stack.

# Refuse to double-start: a second launch against the same profile just opens
# a tab in the running browser and exits, so a second copy of the restart loop
# below becomes a tab-spawning loop. The /proc check ignores a stale pidfile
# whose pid was recycled by an unrelated process.
PIDFILE=/tmp/cww-browser.pid
oldpid="$(cat "$PIDFILE" 2>/dev/null)"
if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null \
        && grep -q cww-browser "/proc/$oldpid/cmdline" 2>/dev/null; then
    echo "[cww-browser] already running (pid $oldpid); refusing to start a second stack." >&2
    echo "[cww-browser] to relaunch: kill $oldpid and any leftover Xvfb/x11vnc/websockify/browser processes, then run cww-browser again." >&2
    exit 1
fi
echo $$ > "$PIDFILE"

RES="${CWW_BROWSER_RESOLUTION:-1920x1080}"

CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium)"
if [ -z "$CHROME_BIN" ]; then
    echo "[cww-browser] ERROR: no browser installed (expected google-chrome or chromium)" >&2
    exit 1
fi

Xvfb :99 -screen 0 "${RES}x24" -nolisten tcp &
for _ in $(seq 1 50); do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.2
done
export DISPLAY=:99

# VNC stays on the container's loopback; only websockify/noVNC listens on the
# container network, and only ITS port gets published (to the host's loopback).
x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet -bg
websockify --web /usr/share/novnc 0.0.0.0:7900 localhost:5900 &

# --no-sandbox: the browser's sandbox needs privileges an unprivileged
#   container user doesn't have; the container is the sandbox here.
# --user-data-dir: Chrome/Chromium >=136 refuse --remote-debugging-port on the
#   default profile dir; a dedicated one also keeps browser state out of ~.
while true; do
    "$CHROME_BIN" \
        --no-sandbox \
        --no-first-run \
        --no-default-browser-check \
        --remote-debugging-port=9222 \
        --user-data-dir=/home/developer/chrome-profile \
        --window-position=0,0 \
        --window-size="${RES/x/,}" \
        about:blank || true
    echo "[cww-browser] Browser exited; restarting in 1s ..."
    sleep 1
done
