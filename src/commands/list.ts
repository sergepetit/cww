// cww list — list all active Coder Workspace Workflow sessions.

import path from "node:path";
import { AGENT_VERSION_FILE, parseAgentVersion } from "../agents/registry";
import {
  formatPortsDisplay,
  getPortMap,
  imageAgeHours,
  imageIsStale,
  inspectContainers,
  inspectImages,
  readContainerFile,
  readImageFile,
  STALE_IMAGE_DAYS,
  type ContainerInfo,
  type ImageInfo,
  type PortBinding,
} from "../lib/docker";
import { findAllSessions, readSessionFile } from "../lib/session";
import { GREEN, NC, RED, YELLOW } from "../lib/ui";
import { parseCommandArgs } from "./common";

const USAGE = `Usage: cww list [options]

List all active Coder Workspace Workflow sessions.

IMAGE is the age of the image each workspace runs (its agent CLI is frozen at
build time); '*' marks a workspace whose image tag has been rebuilt since.

Options:
  --versions     Also read each workspace's agent CLI version (one docker call
                 per running workspace, one per distinct stopped image)
  --json         Output as JSON (carries every field the table omits, the
                 workspace's branch and task dir among them)
  -h, --help     Show this help message
`;

// An agent CLI is frozen into the image a workspace was created from, so two
// separate facts decide whether it is current, and they have different
// remedies: how old that image is (rebuild it), and whether its tag has since
// been rebuilt without this container following (teardown + recreate).
export interface WorkspaceImage {
  ref: string; // .Config.Image — the tag the container was created from
  id: string; // the image it actually runs
  created: string | null; // that image's build time; null if it is gone
  ageHours: number | null;
  drifted: boolean;
}

export interface SessionRow {
  project: string;
  workspace: string;
  branch: string;
  agent: string;
  container: string;
  status: "running" | "stopped" | "no-container";
  ports: PortBinding[];
  portsDisplay: string;
  image: WorkspaceImage | null; // null when the container is gone
  // Only with --versions: the agent CLI stamped into the image. null when the
  // stamp is missing (an image built before it existed); absent entirely when
  // versions weren't asked for, or there is no container to read.
  version?: string | null;
  // Not a table column: the path is derivable from project + workspace and
  // only matters when you are about to open it, so it rides --json instead of
  // widening every default listing. Also what getPortMap reads.
  taskDir: string;
  created: string;
}

// Age is measured against the image the container actually runs, and drift
// against its OWN .Config.Image — never the agent's canonical tag: a
// per-project image (.cww/Dockerfile -> cww-project-<name>:<agent>) would
// otherwise be compared to an image it was never built from.
export function workspaceImage(
  container: ContainerInfo | undefined,
  images: Map<string, ImageInfo>,
  now: number,
): WorkspaceImage | null {
  if (!container) return null;
  const own = images.get(container.imageId);
  const tag = container.imageRef ? images.get(container.imageRef) : undefined;
  const created = own?.created ?? null;
  return {
    ref: container.imageRef,
    id: container.imageId,
    created,
    ageHours: imageAgeHours(created, now),
    drifted: !!tag && tag.id !== container.imageId,
  };
}

// The agent CLI version, which unlike age and drift is NOT in image metadata:
// it only exists as a file the image bakes at build time, so reading it costs
// a docker call per workspace — hence --versions rather than the default
// table. Running containers are read with an exec; the rest need a throwaway
// container over the image, deduped, so N workspaces sharing an image cost one
// spawn, not N. All of it runs concurrently.
async function attachVersions(
  rows: SessionRow[],
  containers: Map<string, ContainerInfo>,
): Promise<void> {
  const byImage = new Map<string, Promise<string | null>>();
  await Promise.all(
    rows.map(async (row) => {
      const info = containers.get(row.container);
      if (!info) return; // no container: nothing to read from
      let raw: string | null;
      if (info.running) {
        raw = await readContainerFile(row.container, AGENT_VERSION_FILE);
      } else {
        let pending = byImage.get(info.imageId);
        if (!pending) {
          pending = readImageFile(info.imageId, AGENT_VERSION_FILE);
          byImage.set(info.imageId, pending);
        }
        raw = await pending;
      }
      row.version = raw ? parseAgentVersion(raw) : null;
    }),
  );
}

async function collectSessions(opts: { versions?: boolean } = {}): Promise<SessionRow[]> {
  // One instant for the whole table, so ages are comparable across rows.
  const now = Date.now();
  const sessions = findAllSessions().map((file) => ({
    taskDir: path.dirname(file),
    session: readSessionFile(file),
  }));

  // Two batched docker calls for the whole table: state and image fields per
  // container, then every distinct image reference they name. Nothing execs,
  // so stopped workspaces report as fully as running ones.
  const containers = await inspectContainers(sessions.map((s) => s.session.container ?? ""));
  const images = await inspectImages(
    [...containers.values()].flatMap((c) => [c.imageId, c.imageRef]),
  );

  const rows: SessionRow[] = [];
  for (const { taskDir, session } of sessions) {
    const container = session.container ?? "unknown";
    const info = containers.get(container);
    const status: SessionRow["status"] = !info
      ? "no-container"
      : info.running
        ? "running"
        : "stopped";

    // Published ports across the task's compose stack (empty unless running).
    const ports = await getPortMap(taskDir);

    rows.push({
      project: session.project ?? "unknown",
      workspace: session.workspace ?? "unknown",
      branch: session.branch ?? "unknown",
      agent: session.agent ?? "claude",
      container,
      status,
      ports,
      portsDisplay: formatPortsDisplay(ports),
      image: workspaceImage(info, images, now),
      taskDir,
      created: session.created ?? "unknown",
    });
  }

  if (opts.versions) await attachVersions(rows, containers);
  return rows;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const STATUS_COLOR: Record<SessionRow["status"], string> = {
  running: GREEN,
  stopped: YELLOW,
  "no-container": RED,
};

const DRIFT_MARK = "*";

export const DRIFT_LEGEND = `${DRIFT_MARK} image rebuilt since this workspace was created — 'cww teardown' + 'cww create' to pick it up.`;

// 'cww build' re-resolves the agent CLI by default, so this is a remedy the
// reader can act on as written (see src/agents/registry.ts, agentBuildPlan).
export const STALE_LEGEND = `Images over ${STALE_IMAGE_DAYS}d: 'cww build <agent>' installs the current CLI, then teardown + create moves a workspace onto it.`;

// The stamp is a build-time artifact, so images built before it existed simply
// don't carry it — and no amount of asking the container will produce one.
export const UNKNOWN_VERSION_LEGEND = `VERSION '?': this image predates the version stamp — it appears after the next 'cww build <agent>'.`;

// Compact age of the image the workspace runs, marked when its tag has moved
// on: "5h", "12d", "12d *". "?" is an image that no longer exists locally.
export function formatImageCell(image: WorkspaceImage | null): string {
  if (!image) return "-";
  const age =
    image.ageHours === null
      ? "?"
      : image.ageHours < 24
        ? `${image.ageHours}h`
        : `${Math.floor(image.ageHours / 24)}d`;
  return image.drifted ? `${age} ${DRIFT_MARK}` : age;
}

function isOld(image: WorkspaceImage | null): boolean {
  return !!image && imageIsStale(image.ageHours);
}

// Both facts are worth acting on, so both color the cell — the legends below
// separate them, since the remedies differ.
function isStale(image: WorkspaceImage | null): boolean {
  return !!image && (image.drifted || isOld(image));
}

// Color belongs to the value, not the column: status always carries one, IMAGE
// only when it is worth acting on.
interface Column {
  header: string;
  cell: (row: SessionRow) => string;
  color?: (row: SessionRow) => string | null;
}

// VERSION is conditional, so columns are described rather than indexed —
// nothing downstream has to know which position anything landed in.
function columnsFor(versions: boolean): Column[] {
  return [
    { header: "WORKSPACE", cell: (r) => r.workspace },
    {
      header: "STATUS",
      cell: (r) => (r.status === "no-container" ? "error" : r.status),
      color: (r) => STATUS_COLOR[r.status],
    },
    { header: "PROJECT", cell: (r) => r.project },
    { header: "AGENT", cell: (r) => r.agent },
    ...(versions ? [{ header: "VERSION", cell: formatVersionCell } as Column] : []),
    {
      header: "IMAGE",
      cell: (r) => formatImageCell(r.image),
      color: (r) => (isStale(r.image) ? YELLOW : null),
    },
    { header: "PORTS", cell: (r) => r.portsDisplay || "-" },
  ];
}

// "-" when there was no container to read from, "?" when there was one but its
// image predates the version stamp.
export function formatVersionCell(row: SessionRow): string {
  if (row.version === undefined) return "-";
  return row.version ?? "?";
}

// Columns auto-size to their widest value — nothing is truncated; overly wide
// output degrades to terminal line-wrap. Color is applied after padding so
// ANSI codes never enter the width math.
export function formatTable(rows: SessionRow[], opts: { versions?: boolean } = {}): string[] {
  const columns = columnsFor(!!opts.versions);
  const table = rows.map((row) => columns.map((c) => c.cell(row)));
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...table.map((cells) => cells[i]!.length)),
  );

  const lines = [
    columns.map((c, i) => pad(c.header, widths[i]!)).join("  ").trimEnd(),
    columns.map((c, i) => pad("-".repeat(c.header.length), widths[i]!)).join("  ").trimEnd(),
  ];
  table.forEach((cells, r) => {
    const line = cells
      .map((cell, i) => {
        const padded = pad(cell, widths[i]!);
        const color = columns[i]!.color?.(rows[r]!) ?? null;
        return color ? `${color}${padded}${NC}` : padded;
      })
      .join("  ");
    lines.push(line.trimEnd());
  });
  const legends: string[] = [];
  if (rows.some((row) => row.image?.drifted)) legends.push(DRIFT_LEGEND);
  if (rows.some((row) => isOld(row.image))) legends.push(STALE_LEGEND);
  if (opts.versions && rows.some((row) => row.version === null)) legends.push(UNKNOWN_VERSION_LEGEND);
  if (legends.length > 0) lines.push("", ...legends);
  return lines;
}

function printTable(rows: SessionRow[], opts: { versions?: boolean }): void {
  for (const line of formatTable(rows, opts)) console.log(line);
}

export async function runList(argv: string[]): Promise<void> {
  const args = parseCommandArgs(
    argv,
    USAGE,
    { versions: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    { allowPositionals: false },
  );
  if (!args) return;
  const { json, versions } = args.values;

  const rows = await collectSessions({ versions });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No workspaces found.");
    console.log("");
    console.log("Use 'cww create <name>' to create one.");
    return;
  }

  printTable(rows, { versions });
}
