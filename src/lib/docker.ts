// Docker and docker-compose plumbing for a workspace's container stack: one
// function per docker/compose operation, plus the pure parsers for what those
// commands print. Deliberately free of any agent-registry import, so nothing
// here can close a cycle back through the agent modules — the sequences that
// need the registry live in workspace.ts and cache-dir.ts.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { info } from "./ui";

// docker --format templates are interpolated so Bun Shell never parses their
// braces.
const NAMES_FMT = "{{.Names}}";
const PORTS_FMT = "{{.Ports}}";

// Container exists (running or stopped).
export async function containerExists(name: string): Promise<boolean> {
  const r = await $`docker ps -a --format ${NAMES_FMT}`.quiet().nothrow();
  return r.text().split("\n").includes(name);
}

export async function containerRunning(name: string): Promise<boolean> {
  const r = await $`docker ps --format ${NAMES_FMT}`.quiet().nothrow();
  return r.text().split("\n").includes(name);
}

// One `docker inspect` for a whole set of workspace containers: state, plus
// the two image fields 'cww list' reports on. The template echoes .Name, so
// results correlate by name rather than by argument order — inspect still
// prints the containers it found when others are missing (and exits 1), and
// missing ones simply don't come back. --type container keeps a same-named
// image from matching, which would fail the template instead.
const INSPECT_FMT = "{{.Name}}|{{.State.Running}}|{{.Image}}|{{.Config.Image}}";

export interface ContainerInfo {
  running: boolean;
  imageId: string; // .Image — the image this container actually runs
  imageRef: string; // .Config.Image — the tag it was created from
}

export function parseContainerInspect(text: string): Map<string, ContainerInfo> {
  const out = new Map<string, ContainerInfo>();
  for (const line of text.split("\n")) {
    const [name, running, imageId, imageRef] = line.split("|");
    if (!name || !imageId) continue;
    // docker reports container names with a leading slash.
    out.set(name.replace(/^\//, ""), {
      running: running === "true",
      imageId,
      imageRef: imageRef ?? "",
    });
  }
  return out;
}

export async function inspectContainers(names: string[]): Promise<Map<string, ContainerInfo>> {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const r = await $`docker inspect --type container --format ${INSPECT_FMT} ${unique}`
    .quiet()
    .nothrow();
  return parseContainerInspect(r.text());
}

const IMAGE_INSPECT_FMT = "{{.Id}}|{{.Created}}|{{.RepoTags}}";

export interface ImageInfo {
  id: string;
  created: string; // RFC3339 build time
}

// Keyed by BOTH the image id and each of its repo tags, from one pass: a
// caller can resolve the frozen id a container runs AND what a tag points at
// today from the same map, without matching results back to the refs it asked
// for. An id whose tag has since moved comes back untagged, which is exactly
// the drift signal.
export function parseImageInspect(text: string): Map<string, ImageInfo> {
  const out = new Map<string, ImageInfo>();
  for (const line of text.split("\n")) {
    const [id, created, repoTags] = line.split("|");
    if (!id || !created) continue;
    const info: ImageInfo = { id, created };
    out.set(id, info);
    // {{.RepoTags}} renders a Go slice: "[repo:tag repo:other]".
    for (const tag of (repoTags ?? "").replace(/^\[|\]$/g, "").split(/\s+/)) {
      if (tag && tag !== "<none>:<none>") out.set(tag, info);
    }
  }
  return out;
}

export async function inspectImages(refs: string[]): Promise<Map<string, ImageInfo>> {
  const unique = [...new Set(refs.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const r = await $`docker image inspect --format ${IMAGE_INSPECT_FMT} ${unique}`.quiet().nothrow();
  return parseImageInspect(r.text());
}

// How old an image may get before cww says something. An agent CLI is
// installed when its image is built and never moves inside a container, so
// this is really the age of the CLI. One threshold, shared by 'cww list' and
// the create-time hint — two would drift apart.
export const STALE_IMAGE_DAYS = 30;

export function imageAgeHours(
  created: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!created) return null;
  const at = Date.parse(created);
  // Clamped at 0: a host clock behind the daemon's shouldn't read as negative.
  return Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 3_600_000));
}

export function imageIsStale(ageHours: number | null): boolean {
  return ageHours !== null && ageHours >= STALE_IMAGE_DAYS * 24;
}

// Read a small baked file out of a running container. Null when the container
// is not running, the file is absent, or it is empty — every caller of these
// two treats "couldn't read it" as unknown, never as an error.
export async function readContainerFile(container: string, file: string): Promise<string | null> {
  const r = await $`docker exec ${container} cat ${file}`.quiet().nothrow();
  return r.exitCode === 0 ? r.text().trim() || null : null;
}

// Same, for a container that isn't running: a throwaway container over the
// image, which costs a create+start (~a second) — so callers dedupe by image
// rather than doing this per workspace. Takes an image id or tag, so a
// workspace stuck on a superseded image is read from the image it actually
// has.
export async function readImageFile(image: string, file: string): Promise<string | null> {
  const r = await $`docker run --rm --entrypoint cat ${image} ${file}`.quiet().nothrow();
  return r.exitCode === 0 ? r.text().trim() || null : null;
}

// Fall back to locating a workspace's agent container by name pattern when no
// session file exists. Expects an already-sanitized workspace name (which only
// contains [a-z0-9-], so it is safe inside the anchored regex).
export async function findWorkspaceContainer(sanitizedWorkspace: string): Promise<string | null> {
  const r = await $`docker ps -a --format ${NAMES_FMT}`.quiet().nothrow();
  const re = new RegExp(`^cww-.*-${sanitizedWorkspace}$`);
  return r.text().split("\n").find((name) => re.test(name)) ?? null;
}

export interface PortBinding {
  container: number;
  host: number;
}

// Parse docker's {{.Ports}} fields (one per container) into deduplicated
// container->host bindings. IPv6 (:::) rows are dropped: Docker can assign a
// different ephemeral host port to the v6 binding, and tunnel-command forwards
// over IPv4 localhost.
export function parsePortMap(portsFields: string[]): PortBinding[] {
  const seen = new Set<string>();
  const out: PortBinding[] = [];
  for (const field of portsFields) {
    for (const part of field.split(",")) {
      if (part.includes(":::")) continue;
      const m = part.match(/[0-9.]+:([0-9]+)->([0-9]+)/);
      if (!m) continue;
      const binding = { host: Number(m[1]), container: Number(m[2]) };
      const key = `${binding.container}:${binding.host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(binding);
    }
  }
  return out.sort((a, b) => a.container - b.container || a.host - b.host);
}

// Published bindings across a task's whole compose stack (agent + services).
// Compose labels every container with com.docker.compose.project set to the
// task dir basename — the same -p name taskCompose pins — so we can find them
// regardless of container state. Only running containers publish ports, so
// this is empty for stopped tasks.
export async function getPortMap(taskDir: string): Promise<PortBinding[]> {
  const project = path.basename(taskDir);
  const r = await $`docker ps --filter label=com.docker.compose.project=${project} --format ${PORTS_FMT}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) return [];
  return parsePortMap(r.text().split("\n").filter(Boolean));
}

// Compact "container->host,container->host" display string.
export function formatPortsDisplay(map: PortBinding[]): string {
  return map.map((p) => `${p.container}->${p.host}`).join(",");
}

// The published host ports as a sorted, comma-separated list (e.g.
// "49153,49155").
export function publishedPortsCsv(map: PortBinding[]): string {
  return [...new Set(map.map((p) => p.host))].sort((a, b) => a - b).join(",");
}

// The compose -f arguments a task was created with: the base file plus
// whichever optional layers 'cww create' generated.
export function composeFileArgs(taskDir: string): string[] {
  const args = ["-f", path.join(taskDir, "docker-compose.yml")];
  for (const optional of [
    "docker-compose.services.yml",
    "docker-compose.hosts.yml",
    "docker-compose.browser.yml",
    "docker-compose.agent.yml",
  ]) {
    const file = path.join(taskDir, optional);
    if (fs.existsSync(file)) args.push("-f", file);
  }
  return args;
}

// Run a docker compose subcommand against a task's whole stack, layering the
// same override files 'cww create' used. An explicit -p pins the project name
// to the task dir basename — the name compose derived from the cwd at 'up'
// time — so teardown targets the agent container AND its services (DB, etc.)
// + network, regardless of the current directory.
export async function taskCompose(
  taskDir: string,
  args: string[],
  opts: { quiet?: boolean } = {},
): Promise<number> {
  const files = composeFileArgs(taskDir);
  const cmd = $`docker compose -p ${path.basename(taskDir)} ${files} ${args}`;
  const r = await (opts.quiet ? cmd.quiet() : cmd).nothrow();
  return r.exitCode;
}

// Tear down a workspace's whole compose stack (agent + services + network +
// this workspace's volumes) and remove its host metadata dir. Idempotent.
// Needs the compose files, so it runs before the task dir is removed.
export async function teardownTask(taskDir: string, container: string): Promise<void> {
  await taskCompose(taskDir, ["down", "--volumes", "--remove-orphans"], { quiet: true });
  // Belt and suspenders: the agent container has an explicit container_name,
  // so remove it directly too in case the compose files were missing.
  if (container) await $`docker rm -f ${container}`.quiet().nothrow();
  fs.rmSync(taskDir, { recursive: true, force: true });
}

// Run the project's optional .cww/reset.sh inside the container to reset/
// reseed service data. Runs as the developer user with cwd /workspace, so it
// can reach services over the compose network by hostname. Returns "no-script"
// (without output) when no script is present, so callers can decide whether to
// announce that.
export async function runResetScript(
  projectPath: string,
  container: string,
): Promise<"ok" | "no-script"> {
  const src = path.join(projectPath, ".cww", "reset.sh");
  if (!fs.existsSync(src)) return "no-script";
  info("Running .cww/reset.sh in the workspace...");
  await $`docker cp ${src} ${container}:/tmp/cww-reset.sh`.quiet();
  await $`docker exec -u root ${container} chmod +x /tmp/cww-reset.sh`;
  await $`docker exec -w /workspace ${container} bash /tmp/cww-reset.sh`;
  return "ok";
}

// Attach to a workspace's agent tmux session. Unlike the bash lib this can't
// exec-replace the process; the CLI stays as parent and exits with tmux's
// status.
export async function attachAgentSession(container: string): Promise<never> {
  const proc = Bun.spawn(["docker", "exec", "-it", container, "tmux", "attach", "-t", "main"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
