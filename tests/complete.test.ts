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

describe("auth topics", () => {
  const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

  test("auth-targets lists the agents plus 'git'", () => {
    const r = Bun.spawnSync({ cmd: ["bun", cli, "__complete", "auth-targets"], stdout: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim().split("\n")).toEqual([...CWW_AGENTS, "git"]);
  });

  test("auth-methods lists an agent's method ids", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", cli, "__complete", "auth-methods", "claude"],
      stdout: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim().split("\n")).toEqual([
      "oauth-token",
      "api-key",
      "none",
    ]);
  });

  test("auth-methods-all is the deduplicated union of every agent's method ids", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", cli, "__complete", "auth-methods-all"],
      stdout: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const ids = new TextDecoder().decode(r.stdout).trim().split("\n");
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["oauth-token", "api-key", "none", "config-file", "anthropic-api-key"]) {
      expect(ids).toContain(id);
    }
  });

  test("auth-methods without a known agent yields no candidates", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", cli, "__complete", "auth-methods", "nope"],
      stdout: "pipe",
    });
    expect(r.exitCode).toBe(1);
  });
});
