// The interactive repo setup flow shared by 'cww create' (first run in a
// repo) and 'cww init' (explicit re-run: token rotation, URL change). It
// captures the clone URL, validates the credential against the real forge
// with 'git ls-remote' BEFORE anything is stored, verifies the URL is also
// reachable FROM A CONTAINER (the host resolving/reaching it proves nothing
// about container DNS), then persists the token in ~/.cww/credentials and
// the project entry in ~/.cww/config.json.

import { $ } from "bun";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  credentialsFile,
  loadCredentials,
  matchCredential,
  saveCredentials,
  upsertCredential,
} from "./credentials";
import { findAnyCwwImage } from "./cache-dir";
import { appendGlobalHost, globalHostsFile, hostsEntries } from "./hosts";
import { normalizeGitUrl } from "./naming";
import { getProjectConfig, setProjectConfig } from "./user-config";
import { confirm, die, error, info, promptSecret, success, warn } from "./ui";

const INLINE_HELPER = '!f(){ echo "username=$CWW_PROBE_USER"; echo "password=$CWW_PROBE_TOKEN"; };f';

// One-shot ls-remote with ONLY the candidate credential: the first empty
// credential.helper clears any configured helpers so the host's keychain
// can't silently satisfy the probe and mask a bad token; GIT_TERMINAL_PROMPT
// and GIT_ASKPASS keep git from falling back to interactive prompts. The
// secret travels via the child's environment, never argv.
export async function probeCredential(
  url: string,
  user: string,
  token: string,
): Promise<{ ok: boolean; stderr: string }> {
  const r = await $`git -c credential.helper= -c credential.helper=${INLINE_HELPER} ls-remote ${url} HEAD`
    .env({
      ...process.env,
      CWW_PROBE_USER: user,
      CWW_PROBE_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/true",
    })
    .quiet()
    .nothrow();
  return { ok: r.exitCode === 0, stderr: r.stderr.toString().trim() };
}

// Credential-less ls-remote (helpers cleared the same way): succeeds only
// for a repo that is publicly readable from this host.
async function probeAnonymous(url: string): Promise<{ ok: boolean; stderr: string }> {
  const r = await $`git -c credential.helper= ls-remote ${url} HEAD`
    .env({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" })
    .quiet()
    .nothrow();
  return { ok: r.exitCode === 0, stderr: r.stderr.toString().trim() };
}

// The same ls-remote from a throwaway container, with the extra_hosts a
// workspace would get. Container DNS skips the host's /etc/hosts, mDNS and
// ssh aliases, so this catches "clones will fail inside" while the host-side
// probe passes. The secret is forwarded from the client env by name (-e
// NAME), never on the docker argv; 'timeout 15' bounds an unroutable host.
export type ContainerProbe = { status: "ok" | "resolve" | "unreachable" | "docker"; stderr: string };
export async function probeFromContainer(
  url: string,
  user: string,
  token: string,
  projectPath: string,
  image: string,
): Promise<ContainerProbe> {
  const addHosts = hostsEntries(projectPath).flatMap((e) => ["--add-host", `${e.host}:${e.ip}`]);
  const gitCred = token
    ? ["-c", "credential.helper=", "-c", `credential.helper=${INLINE_HELPER}`]
    : ["-c", "credential.helper="];
  const r =
    await $`docker run --rm ${addHosts} -e CWW_PROBE_USER -e CWW_PROBE_TOKEN -e GIT_TERMINAL_PROMPT --entrypoint timeout ${image} 15 git ${gitCred} ls-remote ${url} HEAD`
      .env({
        ...process.env,
        CWW_PROBE_USER: user,
        CWW_PROBE_TOKEN: token,
        GIT_TERMINAL_PROMPT: "0",
      })
      .quiet()
      .nothrow();
  const stderr = r.stderr.toString().trim();
  if (r.exitCode === 0) return { status: "ok", stderr };
  // Docker itself failed, not the repo: a daemon connection error exits 1
  // with a distinctive message, run-level failures exit 125-127. git's own
  // failures exit 128, which must NOT land here.
  if (
    /docker daemon|docker api|error during connect/i.test(stderr) ||
    (r.exitCode >= 125 && r.exitCode <= 127)
  ) {
    return { status: "docker", stderr };
  }
  if (/could not resolve host/i.test(stderr)) return { status: "resolve", stderr };
  if (r.exitCode === 124) {
    return {
      status: "unreachable",
      stderr: stderr || "timed out after 15s — host unreachable from the container?",
    };
  }
  return { status: "unreachable", stderr };
}

// RFC1918 + link-local — "is this a LAN address" for the macOS Local Network
// permission hint.
function isPrivateIp(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/.test(ip);
}

// The host's view of a name (getaddrinfo: /etc/hosts, mDNS, DNS) — used to
// suggest the ~/.cww/hosts mapping when only the container fails to resolve.
async function resolveOnHost(host: string): Promise<string | null> {
  try {
    return (await lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
}

// The container's view of the same name, with the workspace's extra_hosts
// applied (so an existing mapping shows through). Null when it doesn't
// resolve at all. Containers may resolve a host-only name to a WRONG address
// (e.g. a 127.x self-entry leaking through DNS forwarding) — comparing this
// against the host's view is what proves a ~/.cww/hosts mapping is needed.
export async function containerResolves(
  host: string,
  projectPath: string,
  image: string,
): Promise<string | null> {
  const addHosts = hostsEntries(projectPath).flatMap((e) => ["--add-host", `${e.host}:${e.ip}`]);
  const r = await $`docker run --rm ${addHosts} --entrypoint getent ${image} hosts ${host}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) return null;
  return r.text().trim().split(/\s+/)[0] || null;
}

// Interactive setup for a repo. projectPath must be the git root. Returns the
// clone URL the project is now configured with.
export async function setupRepo(
  projectPath: string,
  opts: { remote?: string } = {},
): Promise<string> {
  const remoteName = opts.remote || "origin";
  const remoteR = await $`git -C ${projectPath} remote get-url ${remoteName}`.quiet().nothrow();
  if (opts.remote && remoteR.exitCode !== 0) {
    die(`Remote '${opts.remote}' not found in ${projectPath}. Run 'git remote -v' to list remotes.`);
  }
  const derived = remoteR.exitCode === 0 ? normalizeGitUrl(remoteR.text().trim()) : "";
  const existing = getProjectConfig(projectPath);
  let suggested = (!opts.remote && existing?.repoUrl) || derived;

  console.log("");
  info("Clone URL: what workspaces 'git clone' INSIDE the container — over");
  info("https (SSH keys are not mounted), and reachable from the container");
  info("(self-hosted forge on plain http or a custom port? type that URL).");

  let cloneUrl = "";
  urlLoop: for (;;) {
    // --- Clone URL ---------------------------------------------------------
    const answer = (prompt(`Clone URL${suggested ? ` [${suggested}]` : ""}:`) ?? "").trim();
    cloneUrl = answer || suggested;
    if (!cloneUrl) die("No clone URL: the repo has no usable remote and none was typed.");
    if (!/^https?:\/\//.test(cloneUrl)) {
      die(`Clone URL must be http(s), got: ${cloneUrl} (the container authenticates with a token over https).`);
    }
    suggested = cloneUrl; // returning to this prompt means editing, not resetting

    // --- Credential, validated host-side before it is stored ----------------
    // Reloaded each pass: an earlier pass may have stored an entry already.
    const entries = loadCredentials();
    const stored = matchCredential(entries, cloneUrl);
    if (stored) info(`Existing credential entry: ${stored.url} (user: ${stored.user})`);

    let user = "";
    let token = "";
    for (;;) {
      const defUser = stored?.user || "x-access-token";
      user =
        (prompt(`Git user [${defUser}] (Forgejo/Gitea: your login; GitHub fine-grained PAT: x-access-token):`) ?? "")
          .trim() || defUser;
      token = promptSecret(
        stored
          ? "Token (input hidden; Enter keeps the stored one)"
          : "Token (input hidden; Enter for none — public repos only)",
      );
      if (!token && stored) token = stored.token;

      // No token at all: acceptable only when the repo is anonymously readable.
      if (!token) {
        info(`No token given — checking whether ${cloneUrl} is publicly readable ...`);
        const anon = await probeAnonymous(cloneUrl);
        if (anon.ok) {
          warn("Public repo: cloning will work without a credential, but pushes from");
          warn("inside a workspace will fail until you store one with 'cww init'.");
          break;
        }
        error("The repo is not anonymously readable — a token is required:");
        for (const l of anon.stderr.split("\n")) console.error(`    ${l}`);
        continue;
      }

      info(`Validating against ${cloneUrl} ...`);
      const probe = await probeCredential(cloneUrl, user, token);
      if (probe.ok) {
        // Store under the exact repo URL — the fine-grained-PAT model.
        // Hand-edit ~/.cww/credentials to widen an entry to a whole host.
        saveCredentials(upsertCredential(entries, { user, token, url: cloneUrl }));
        success(`Credential validated and stored in ${credentialsFile()} (mode 600).`);
        break;
      }
      error("Validation failed:");
      for (const l of probe.stderr.split("\n")) console.error(`    ${l}`);
      if (!confirm("Try again with different credentials?")) {
        die("Nothing saved. Fix the URL/token and re-run 'cww init'.");
      }
    }

    // --- Reachability from a container --------------------------------------
    const image = await findAnyCwwImage();
    if (!image) {
      info("No cww image built yet — skipping the container-side reachability check.");
      break;
    }
    info("Checking the URL is reachable from a container ...");
    for (;;) {
      const probe = await probeFromContainer(cloneUrl, user, token, projectPath, image);
      if (probe.status === "ok") break urlLoop;
      if (probe.status === "docker") {
        warn("Could not probe from a container (docker error) — skipping the check:");
        for (const l of probe.stderr.split("\n")) warn(`  ${l}`);
        break urlLoop;
      }

      error("The repo is not reachable from a container:");
      for (const l of probe.stderr.split("\n")) console.error(`    ${l}`);

      // Diagnose name resolution: the host reaches the URL (validation
      // passed), so when the container sees a DIFFERENT address — or none —
      // for the same name, a ~/.cww/hosts mapping is the fix. Same address
      // on both sides means the route/port itself is the problem.
      const host = new URL(cloneUrl).hostname;
      if (isIP(host) === 0) {
        const hostIp = await resolveOnHost(host);
        const containerIp = await containerResolves(host, projectPath, image);
        if (hostIp && hostIp !== containerIp) {
          info(
            containerIp
              ? `Containers resolve '${host}' to ${containerIp}; your host resolves it to ${hostIp}.`
              : `Containers cannot resolve '${host}'; your host resolves it to ${hostIp}.`,
          );
          info("(Container DNS skips the host's /etc/hosts, mDNS and ssh aliases.)");
          if (confirm(`Map ${host} -> ${hostIp} for all workspaces (append to ${globalHostsFile()})?`)) {
            appendGlobalHost(host, hostIp);
            info("Added. Re-checking ...");
            continue;
          }
        } else if (hostIp) {
          info(`Host and containers both resolve '${host}' to ${hostIp} — the address is right,`);
          info("but the route or port isn't (host only reachable via VPN? firewall?).");
          if (process.platform === "darwin" && isPrivateIp(hostIp)) {
            info("On macOS, a likely cause is the Local Network privacy permission:");
            info("System Settings → Privacy & Security → Local Network must allow Docker,");
            info("or containers get instant 'connection refused' for every LAN host except");
            info("the gateway (internet stays fine). Toggle it, restart Docker, re-run.");
          }
        } else {
          error(`The host cannot resolve '${host}' either — map it by hand in ${globalHostsFile()}.`);
        }
      }
      if (confirm("Continue anyway (the workspace clone will likely fail)?", "n")) break urlLoop;
      continue urlLoop; // back to the URL prompt
    }
  }

  // The entry (with repoUrl always set) is also the "repo is set up" marker
  // 'cww create' checks — written even when the URL matches the derivation.
  // The remote name lets 'cww create --remote <same>' keep using this URL.
  setProjectConfig(projectPath, { repoUrl: cloneUrl, remote: remoteName });
  return cloneUrl;
}
