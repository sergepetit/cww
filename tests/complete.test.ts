import { describe, expect, test } from "bun:test";
import path from "node:path";
import { CWW_AGENTS } from "../src/agents/registry";
import { workspaceNames } from "../src/commands/complete";

describe("workspaceNames", () => {
  test("collects, dedupes, and sorts workspace names", () => {
    expect(
      workspaceNames([
        { workspace: "review" },
        { workspace: "sandbox" },
        { workspace: "review" },
      ]),
    ).toEqual(["review", "sandbox"]);
  });

  test("falls back to branch for pre-rename sessions", () => {
    expect(workspaceNames([{ branch: "feature-x" }])).toEqual(["feature-x"]);
  });

  test("skips sessions with neither workspace nor branch", () => {
    expect(workspaceNames([{}, { workspace: "sandbox" }])).toEqual(["sandbox"]);
  });
});

describe("agents topic", () => {
  // Through the real CLI entry, so the __complete routing is covered too.
  test("prints the registered agents, one per line", () => {
    const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync({ cmd: ["bun", cli, "__complete", "agents"], stdout: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim().split("\n")).toEqual([...CWW_AGENTS]);
  });
});
