import { describe, expect, test } from "bun:test";
import os from "node:os";
import { formatTable, type SessionRow } from "../src/commands/list";

const ANSI = /\x1b\[[0-9;]*m/g;

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    project: "cww-smoketest",
    workspace: "testbun-linux",
    branch: "main",
    agent: "claude",
    container: "cww-cww-smoketest-testbun-linux",
    status: "running",
    ports: [],
    portsDisplay: "",
    taskDir: "/data/tasks/cww-smoketest-testbun-linux",
    created: "2026-07-09",
    ...overrides,
  };
}

describe("formatTable", () => {
  test("never truncates long values", () => {
    const ports = "80->32768,3000->32769,7900->32770,5432->32771";
    const taskDir = "/very/long/path/to/tasks/cww-smoketest-testbun-linux";
    const lines = formatTable([makeRow({ portsDisplay: ports, taskDir })]).map((l) =>
      l.replace(ANSI, ""),
    );
    expect(lines[2]).toContain(ports);
    expect(lines[2]).toContain(taskDir);
  });

  test("columns auto-size and stay aligned across rows", () => {
    const lines = formatTable([
      makeRow({ workspace: "a", portsDisplay: "80->32768" }),
      makeRow({
        workspace: "a-much-longer-workspace-name",
        status: "stopped",
        portsDisplay: "",
      }),
    ]).map((l) => l.replace(ANSI, ""));

    // Every column starts at the same offset on every line: the header's
    // column starts must match the widest row's cell boundaries.
    const statusCol = lines[0]!.indexOf("STATUS");
    expect(statusCol).toBeGreaterThan("a-much-longer-workspace-name".length);
    for (const line of lines.slice(2)) {
      expect(["running", "stopped", "error"]).toContain(
        line.slice(statusCol).split(/\s+/)[0]!,
      );
    }
  });

  test("shortens the home prefix of TASK DIR to ~", () => {
    const taskDir = `${os.homedir()}/.cww/tasks/cww-smoketest-testbun-linux`;
    const lines = formatTable([makeRow({ taskDir })]).map((l) => l.replace(ANSI, ""));
    expect(lines[2]).toContain("~/.cww/tasks/cww-smoketest-testbun-linux");
    expect(lines[2]).not.toContain(os.homedir());
  });

  test("shows '-' for empty ports and 'error' for no-container", () => {
    const lines = formatTable([
      makeRow({ status: "no-container", portsDisplay: "" }),
    ]).map((l) => l.replace(ANSI, ""));
    expect(lines[2]).toContain(" - ");
    expect(lines[2]).toContain("error");
  });
});
