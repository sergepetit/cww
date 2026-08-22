import { describe, expect, test } from "bun:test";
import {
  DRIFT_LEGEND,
  formatImageCell,
  formatTable,
  formatVersionCell,
  STALE_LEGEND,
  UNKNOWN_VERSION_LEGEND,
  workspaceImage,
  type SessionRow,
  type WorkspaceImage,
} from "../src/commands/list";
import { STALE_IMAGE_DAYS, type ContainerInfo, type ImageInfo } from "../src/lib/docker";

const ANSI = /\x1b\[[0-9;]*m/g;

function makeImage(overrides: Partial<WorkspaceImage> = {}): WorkspaceImage {
  return {
    ref: "coder-workspace-workflow:claude",
    id: "sha256:aaa",
    created: "2026-07-09T10:00:00Z",
    ageHours: 5,
    drifted: false,
    ...overrides,
  };
}

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
    image: makeImage(),
    taskDir: "/data/tasks/cww-smoketest-testbun-linux",
    created: "2026-07-09",
    ...overrides,
  };
}

describe("formatTable", () => {
  test("never truncates long values", () => {
    const ports = "80->32768,3000->32769,7900->32770,5432->32771";
    const workspace = "a-very-long-workspace-name-nobody-would-type-twice";
    const lines = formatTable([makeRow({ portsDisplay: ports, workspace })]).map((l) =>
      l.replace(ANSI, ""),
    );
    expect(lines[2]).toContain(workspace);
    expect(lines[2]).toContain(ports);
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

  test("shows '-' for empty ports and 'error' for no-container", () => {
    const lines = formatTable([
      makeRow({ status: "no-container", portsDisplay: "" }),
    ]).map((l) => l.replace(ANSI, ""));
    // PORTS is the last column, so its "-" ends the (right-trimmed) line.
    expect(lines[2]).toMatch(/\s-$/);
    expect(lines[2]).toContain("error");
  });

  test("carries an IMAGE column, and the drift legend only when something drifted", () => {
    const clean = formatTable([makeRow()]).map((l) => l.replace(ANSI, ""));
    expect(clean[0]).toContain("IMAGE");
    expect(clean.join("\n")).not.toContain(DRIFT_LEGEND);

    const drifted = formatTable([
      makeRow({ workspace: "a", image: makeImage({ ageHours: 300, drifted: true }) }),
      makeRow({ workspace: "b", image: makeImage({ drifted: true }) }),
    ]).map((l) => l.replace(ANSI, ""));
    // One legend for the whole table, however many rows are marked.
    expect(drifted.filter((l) => l === DRIFT_LEGEND)).toHaveLength(1);
    expect(drifted[2]).toContain("12d *");
  });

  test("the age legend appears only past the staleness threshold", () => {
    const fresh = formatTable([
      makeRow({ image: makeImage({ ageHours: STALE_IMAGE_DAYS * 24 - 1 }) }),
    ]).map((l) => l.replace(ANSI, ""));
    expect(fresh.join("\n")).not.toContain(STALE_LEGEND);

    const old = formatTable([makeRow({ image: makeImage({ ageHours: STALE_IMAGE_DAYS * 24 }) })]).map(
      (l) => l.replace(ANSI, ""),
    );
    expect(old.filter((l) => l === STALE_LEGEND)).toHaveLength(1);
    // Age and drift are separate facts: an old-but-current image gets no mark.
    expect(old.join("\n")).not.toContain(DRIFT_LEGEND);
    expect(old[2]).toContain(`${STALE_IMAGE_DAYS}d`);
  });
});

describe("the VERSION column", () => {
  test("is absent unless asked for, and appears next to AGENT when it is", () => {
    const plain = formatTable([makeRow()]).map((l) => l.replace(ANSI, ""));
    expect(plain[0]).not.toContain("VERSION");

    const withVersions = formatTable([makeRow({ version: "2.1.216" })], { versions: true }).map(
      (l) => l.replace(ANSI, ""),
    );
    expect(withVersions[0]!.indexOf("VERSION")).toBeGreaterThan(withVersions[0]!.indexOf("AGENT"));
    expect(withVersions[0]!.indexOf("VERSION")).toBeLessThan(withVersions[0]!.indexOf("IMAGE"));
    expect(withVersions[2]).toContain("2.1.216");
  });

  // Adding a column must not shift the coloring off IMAGE/STATUS: the columns
  // are described, not indexed.
  test("does not disturb the other columns' alignment or coloring", () => {
    const rows = [makeRow({ version: "2.1.216", image: makeImage({ ageHours: 300, drifted: true }) })];
    const lines = formatTable(rows, { versions: true });
    const plain = lines.map((l) => l.replace(ANSI, ""));
    const imageCol = plain[0]!.indexOf("IMAGE");
    expect(plain[2]!.slice(imageCol).startsWith("12d *")).toBe(true);
    // The drift-colored cell is the IMAGE one, not VERSION.
    expect(lines[2]).toContain(`\x1b[1;33m12d *`);
  });

  test("'-' without a container, '?' when the image predates the stamp", () => {
    expect(formatVersionCell(makeRow({ version: "1.18.4" }))).toBe("1.18.4");
    expect(formatVersionCell(makeRow({ version: null }))).toBe("?");
    expect(formatVersionCell(makeRow())).toBe("-");
  });

  test("explains '?' once, and only when something is unknown", () => {
    const known = formatTable([makeRow({ version: "2.22.0" })], { versions: true });
    expect(known.join("\n")).not.toContain(UNKNOWN_VERSION_LEGEND);

    const unknown = formatTable([makeRow({ version: null }), makeRow({ version: null })], {
      versions: true,
    });
    expect(unknown.filter((l) => l === UNKNOWN_VERSION_LEGEND)).toHaveLength(1);

    // Not collected at all is not the same as unknown — no legend for '-'.
    expect(formatTable([makeRow()], { versions: true }).join("\n")).not.toContain(
      UNKNOWN_VERSION_LEGEND,
    );
  });
});

describe("formatImageCell", () => {
  test("hours below a day, whole days above, '-' without a container", () => {
    expect(formatImageCell(makeImage({ ageHours: 0 }))).toBe("0h");
    expect(formatImageCell(makeImage({ ageHours: 23 }))).toBe("23h");
    expect(formatImageCell(makeImage({ ageHours: 47 }))).toBe("1d");
    expect(formatImageCell(makeImage({ ageHours: 24 * 45 }))).toBe("45d");
    expect(formatImageCell(null)).toBe("-");
  });

  test("marks drift, and '?' when the image itself is gone", () => {
    expect(formatImageCell(makeImage({ ageHours: 24, drifted: true }))).toBe("1d *");
    expect(formatImageCell(makeImage({ created: null, ageHours: null }))).toBe("?");
    expect(formatImageCell(makeImage({ created: null, ageHours: null, drifted: true }))).toBe("? *");
  });
});

describe("workspaceImage", () => {
  const NOW = Date.parse("2026-07-26T12:00:00Z");
  const OLD: ImageInfo = { id: "sha256:old", created: "2026-07-24T12:00:00Z" };
  const NEW: ImageInfo = { id: "sha256:new", created: "2026-07-26T09:00:00Z" };

  function images(entries: [string, ImageInfo][]): Map<string, ImageInfo> {
    return new Map(entries);
  }

  function container(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
    return {
      running: true,
      imageId: "sha256:old",
      imageRef: "coder-workspace-workflow:claude",
      ...overrides,
    };
  }

  test("ages the image the container runs, not the one its tag points at now", () => {
    const img = workspaceImage(
      container(),
      images([
        ["sha256:old", OLD],
        ["coder-workspace-workflow:claude", NEW],
        ["sha256:new", NEW],
      ]),
      NOW,
    );
    expect(img).toMatchObject({ ageHours: 48, drifted: true, id: "sha256:old" });
  });

  test("no drift while the tag still resolves to the running image", () => {
    const img = workspaceImage(
      container(),
      images([
        ["sha256:old", OLD],
        ["coder-workspace-workflow:claude", OLD],
      ]),
      NOW,
    );
    expect(img).toMatchObject({ ageHours: 48, drifted: false });
  });

  // A per-project image (.cww/Dockerfile) must be measured against its own
  // tag — comparing it to the agent's canonical tag would report permanent
  // drift, since it was never built from it.
  test("resolves against the container's own .Config.Image", () => {
    const img = workspaceImage(
      container({ imageRef: "cww-project-todo:claude" }),
      images([
        ["sha256:old", OLD],
        ["cww-project-todo:claude", OLD],
        ["coder-workspace-workflow:claude", NEW],
      ]),
      NOW,
    );
    expect(img).toMatchObject({ ref: "cww-project-todo:claude", drifted: false });
  });

  test("null without a container; unknown age when the image is gone", () => {
    expect(workspaceImage(undefined, images([]), NOW)).toBeNull();
    expect(workspaceImage(container(), images([]), NOW)).toMatchObject({
      created: null,
      ageHours: null,
      drifted: false,
    });
  });
});
