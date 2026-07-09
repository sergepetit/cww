// cww list — list all active Coder Workspace Workflow sessions.

import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  containerExists,
  containerRunning,
  formatPortsDisplay,
  getPortMap,
  type PortBinding,
} from "../lib/docker";
import { findAllSessions, readSessionFile } from "../lib/session";
import { die, GREEN, NC, RED, YELLOW } from "../lib/ui";

const USAGE = `Usage: cww list [options]

List all active Coder Workspace Workflow sessions.

Options:
  --json         Output as JSON
  -h, --help     Show this help message
`;

export interface SessionRow {
  project: string;
  workspace: string;
  branch: string;
  agent: string;
  container: string;
  status: "running" | "stopped" | "no-container";
  ports: PortBinding[];
  portsDisplay: string;
  taskDir: string;
  created: string;
}

async function collectSessions(): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  for (const sessionFile of findAllSessions()) {
    const taskDir = path.dirname(sessionFile);
    const session = readSessionFile(sessionFile);
    const container = session.container ?? "unknown";

    let status: SessionRow["status"];
    if (await containerRunning(container)) status = "running";
    else if (await containerExists(container)) status = "stopped";
    else status = "no-container";

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
      taskDir,
      created: session.created ?? "unknown",
    });
  }
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

function displayCells(row: SessionRow): string[] {
  const home = os.homedir();
  const taskDir =
    row.taskDir === home || row.taskDir.startsWith(home + path.sep)
      ? `~${row.taskDir.slice(home.length)}`
      : row.taskDir;
  return [
    row.workspace,
    row.status === "no-container" ? "error" : row.status,
    row.project,
    row.agent,
    row.portsDisplay || "-",
    taskDir,
  ];
}

// Columns auto-size to their widest value — nothing is truncated; overly wide
// output degrades to terminal line-wrap. Color is applied after padding so
// ANSI codes never enter the width math.
export function formatTable(rows: SessionRow[]): string[] {
  const headers = ["WORKSPACE", "STATUS", "PROJECT", "AGENT", "PORTS", "TASK DIR"];
  const table = rows.map(displayCells);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...table.map((cells) => cells[i]!.length)),
  );

  const lines = [
    headers.map((h, i) => pad(h, widths[i]!)).join("  ").trimEnd(),
    headers.map((h, i) => pad("-".repeat(h.length), widths[i]!)).join("  ").trimEnd(),
  ];
  table.forEach((cells, r) => {
    const line = cells
      .map((cell, i) => {
        const padded = pad(cell, widths[i]!);
        return i === 1 ? `${STATUS_COLOR[rows[r]!.status]}${padded}${NC}` : padded;
      })
      .join("  ");
    lines.push(line.trimEnd());
  });
  return lines;
}

function printTable(rows: SessionRow[]): void {
  for (const line of formatTable(rows)) console.log(line);
}

export async function runList(argv: string[]): Promise<void> {
  let json = false;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    json = values.json;
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  const rows = await collectSessions();

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

  printTable(rows);
}
