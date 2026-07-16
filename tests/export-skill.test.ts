// The pure planning half of 'cww export-skill': host-skill discovery, source
// resolution, the .cww/skills link plan (and its guard rails), and per-
// workspace injection routing. No Docker anywhere — same philosophy as the
// personalAssetPlan/builtinSkillPlan tests.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentContainerSkillsDir, agentHostSkillsDir, CWW_AGENTS } from "../src/agents/registry";
import {
  findSkillSources,
  injectionTarget,
  linkPlan,
  listHostSkills,
} from "../src/commands/export-skill";
import type { WorkspaceRef } from "../src/lib/session";

// Host skills dirs relative to a fake home, mirroring the agent definitions.
const HOST_DIRS = {
  claude: [".claude", "skills"],
  vibe: [".vibe", "skills"],
  opencode: [".config", "opencode", "skills"],
} as const;

// A throwaway "home" carrying the given skills per agent config dir.
function homeWith(skills: Partial<Record<keyof typeof HOST_DIRS, string[]>>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-home-"));
  for (const [agent, names] of Object.entries(skills)) {
    const dir = path.join(home, ...HOST_DIRS[agent as keyof typeof HOST_DIRS]);
    for (const name of names ?? []) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(
        path.join(dir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\n# ${name}\n`,
      );
    }
  }
  return home;
}

function projectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-proj-"));
}

describe("agentHostSkillsDir", () => {
  test("expands ~ against the given home for every agent", () => {
    expect(agentHostSkillsDir("claude", "/h")).toBe("/h/.claude/skills");
    expect(agentHostSkillsDir("vibe", "/h")).toBe("/h/.vibe/skills");
    expect(agentHostSkillsDir("opencode", "/h")).toBe("/h/.config/opencode/skills");
  });

  test("every registered agent declares a host skills dir", () => {
    for (const agent of CWW_AGENTS) {
      expect(agentHostSkillsDir(agent, "/h")).toBeTruthy();
    }
  });
});

describe("agentContainerSkillsDir", () => {
  test("returns each agent's personalAssets skills dest", () => {
    expect(agentContainerSkillsDir("claude")).toBe("/home/developer/.claude/skills");
    expect(agentContainerSkillsDir("vibe")).toBe("/home/developer/.vibe/skills");
    expect(agentContainerSkillsDir("opencode")).toBe("/home/developer/.config/opencode/skills");
  });

  test("null for an agent id the registry doesn't know", () => {
    expect(agentContainerSkillsDir("mystery")).toBeNull();
  });
});

describe("listHostSkills", () => {
  test("finds skills across agent config dirs, with descriptions", () => {
    const home = homeWith({ claude: ["organize-docs", "deploy"], vibe: ["review"] });
    expect(listHostSkills(home)).toEqual([
      {
        agent: "claude",
        name: "deploy",
        dir: path.join(home, ".claude", "skills", "deploy"),
        description: "Test skill deploy",
      },
      {
        agent: "claude",
        name: "organize-docs",
        dir: path.join(home, ".claude", "skills", "organize-docs"),
        description: "Test skill organize-docs",
      },
      {
        agent: "vibe",
        name: "review",
        dir: path.join(home, ".vibe", "skills", "review"),
        description: "Test skill review",
      },
    ]);
  });

  test("ignores folders without a SKILL.md and missing config dirs", () => {
    const home = homeWith({ claude: ["real"] });
    fs.mkdirSync(path.join(home, ".claude", "skills", "not-a-skill"));
    expect(listHostSkills(home).map((s) => s.name)).toEqual(["real"]);
  });

  test("a symlinked skill folder is discovered like a real one", () => {
    const home = homeWith({ claude: ["real"] });
    fs.symlinkSync(
      path.join(home, ".claude", "skills", "real"),
      path.join(home, ".claude", "skills", "linked"),
    );
    expect(listHostSkills(home).map((s) => s.name)).toEqual(["linked", "real"]);
  });

  test("an empty home yields an empty list", () => {
    expect(listHostSkills(homeWith({}))).toEqual([]);
  });
});

describe("findSkillSources", () => {
  test("a unique name resolves to its one source", () => {
    const home = homeWith({ claude: ["organize-docs"], vibe: ["review"] });
    const sources = findSkillSources("organize-docs", undefined, home);
    expect(sources.map((s) => s.agent)).toEqual(["claude"]);
  });

  test("a name present in several configs returns them all (caller asks for --from)", () => {
    const home = homeWith({ claude: ["deploy"], vibe: ["deploy"] });
    expect(findSkillSources("deploy", undefined, home).map((s) => s.agent)).toEqual([
      "claude",
      "vibe",
    ]);
  });

  test("--from restricts the search to one agent's config", () => {
    const home = homeWith({ claude: ["deploy"], vibe: ["deploy"] });
    expect(findSkillSources("deploy", "vibe", home).map((s) => s.agent)).toEqual(["vibe"]);
  });

  test("unknown names find nothing", () => {
    expect(findSkillSources("nope", undefined, homeWith({ claude: ["real"] }))).toEqual([]);
  });
});

describe("linkPlan", () => {
  const skill = (home: string) => ({
    name: "organize-docs",
    dir: path.join(home, ".claude", "skills", "organize-docs"),
  });

  test("a fresh project gets a symlink to the host skill", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    expect(linkPlan(dir, skill(home), false)).toEqual({
      action: "link",
      path: path.join(dir, ".cww", "skills", "organize-docs"),
      target: skill(home).dir,
    });
  });

  test("--copy plans a copy instead", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    expect(linkPlan(dir, skill(home), true)).toEqual({
      action: "copy",
      path: path.join(dir, ".cww", "skills", "organize-docs"),
      source: skill(home).dir,
    });
  });

  test("never writes through a symlinked .cww/skills that already covers the skill", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    fs.mkdirSync(path.join(dir, ".cww"));
    fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(dir, ".cww", "skills"));
    expect(linkPlan(dir, skill(home), false)).toMatchObject({
      action: "skip",
      reason: "covered-by-linked-dir",
    });
  });

  test("never writes through a symlinked .cww/skills that lacks the skill either", () => {
    const home = homeWith({ claude: ["organize-docs"], vibe: [] });
    const dir = projectDir();
    fs.mkdirSync(path.join(dir, ".cww"));
    // Linked to the (empty) vibe config: the skill isn't covered, but writing
    // .cww/skills/<name> would create it in ~/.vibe/skills — never do that.
    fs.symlinkSync(path.join(home, ".vibe", "skills"), path.join(dir, ".cww", "skills"));
    expect(linkPlan(dir, skill(home), false)).toMatchObject({
      action: "skip",
      reason: "linked-dir",
    });
  });

  test("an entry already linking to this skill is left alone", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    fs.mkdirSync(path.join(dir, ".cww", "skills"), { recursive: true });
    fs.symlinkSync(skill(home).dir, path.join(dir, ".cww", "skills", "organize-docs"));
    expect(linkPlan(dir, skill(home), false)).toMatchObject({
      action: "skip",
      reason: "already-linked",
    });
  });

  test("anything else at the entry path is occupied — never overwritten", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    // A previous --copy (a real directory), and a link to a different skill.
    fs.mkdirSync(path.join(dir, ".cww", "skills", "organize-docs"), { recursive: true });
    expect(linkPlan(dir, skill(home), false)).toMatchObject({ action: "skip", reason: "occupied" });
    expect(linkPlan(dir, skill(home), true)).toMatchObject({ action: "skip", reason: "occupied" });

    const dir2 = projectDir();
    fs.mkdirSync(path.join(dir2, ".cww", "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(dir2, ".cww", "skills", "organize-docs"));
    expect(linkPlan(dir2, skill(home), false)).toMatchObject({ action: "skip", reason: "occupied" });
  });

  test("a broken symlink at the entry path counts as occupied, not a crash", () => {
    const home = homeWith({ claude: ["organize-docs"] });
    const dir = projectDir();
    fs.mkdirSync(path.join(dir, ".cww", "skills"), { recursive: true });
    fs.symlinkSync(path.join(dir, "gone"), path.join(dir, ".cww", "skills", "organize-docs"));
    expect(linkPlan(dir, skill(home), false)).toMatchObject({ action: "skip", reason: "occupied" });
  });
});

describe("injectionTarget", () => {
  function ws(agent?: string): WorkspaceRef {
    return {
      taskDir: "/tasks/proj-sandbox",
      session: agent ? { agent } : {},
      workspace: "sandbox",
      container: "cww-sandbox-agent",
    };
  }

  test("routes into the recorded agent's container skills dir", () => {
    expect(injectionTarget(ws("claude"), "organize-docs").dest).toBe(
      "/home/developer/.claude/skills/organize-docs",
    );
    expect(injectionTarget(ws("vibe"), "organize-docs").dest).toBe(
      "/home/developer/.vibe/skills/organize-docs",
    );
    expect(injectionTarget(ws("opencode"), "organize-docs").dest).toBe(
      "/home/developer/.config/opencode/skills/organize-docs",
    );
  });

  test("a session without an agent defaults to claude (pre-agent sessions)", () => {
    expect(injectionTarget(ws(), "deploy")).toEqual({
      workspace: "sandbox",
      container: "cww-sandbox-agent",
      agent: "claude",
      dest: "/home/developer/.claude/skills/deploy",
    });
  });

  test("an agent the registry doesn't know maps no dest (caller skips it)", () => {
    expect(injectionTarget(ws("mystery"), "deploy").dest).toBeNull();
  });
});
