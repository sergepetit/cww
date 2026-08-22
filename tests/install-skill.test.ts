// The pure half of 'cww install-skill': where the host skill lands per agent,
// the shared entry plan (link / snapshot / never overwrite), and the two
// things that would silently rot — the skill folder missing from the install,
// and install.sh's staged references drifting from BUILTIN_SKILL_REFERENCES.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_SKILL_REFERENCES, CWW_AGENTS, getCwwDir } from "../src/agents/registry";
import { hostSkillDir, HOST_SKILL_NAME, installTargets } from "../src/commands/install-skill";
import { skillEntryPlan, tilde, writeSkillEntry } from "../src/lib/skill-link";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in for the install's skill folder.
function sourceSkill(): string {
  const dir = tmp("cww-test-src-");
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: cww\ndescription: host skill\n---\n");
  return dir;
}

describe("installTargets", () => {
  test("routes to each agent's host skills dir", () => {
    const targets = installTargets(["claude", "opencode"], "/h");
    expect(targets).toEqual([
      { agent: "claude", dir: "/h/.claude/skills", entry: "/h/.claude/skills/cww" },
      { agent: "opencode", dir: "/h/.config/opencode/skills", entry: "/h/.config/opencode/skills/cww" },
    ]);
  });

  test("an agent with no host skills dir yields a null entry rather than a path", () => {
    // Pi declares no host skills dir; --all must skip it, not invent one.
    const pi = installTargets(["pi"], "/h")[0]!;
    expect(pi.dir).toBeNull();
    expect(pi.entry).toBeNull();
  });

  test("--all covers every agent, and every entry is named 'cww'", () => {
    const targets = installTargets(CWW_AGENTS, "/h");
    expect(targets).toHaveLength(CWW_AGENTS.length);
    for (const t of targets) {
      if (t.entry) expect(path.basename(t.entry)).toBe(HOST_SKILL_NAME);
    }
  });
});

describe("skillEntryPlan", () => {
  test("links into a config dir that does not exist yet", () => {
    // A user who has never written a personal skill has no skills/ dir; the
    // plan is still a link, and writeSkillEntry creates the parents.
    const home = tmp("cww-test-home-");
    const source = sourceSkill();
    const entry = path.join(home, ".claude", "skills", "cww");
    const plan = skillEntryPlan(entry, source, false);
    expect(plan).toEqual({ action: "link", path: entry, target: source });
    writeSkillEntry(plan);
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(entry, "SKILL.md"))).toBe(true);
  });

  test("--copy snapshots the folder instead", () => {
    const home = tmp("cww-test-home-");
    const source = sourceSkill();
    const entry = path.join(home, ".claude", "skills", "cww");
    writeSkillEntry(skillEntryPlan(entry, source, true));
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(entry, "SKILL.md"))).toBe(true);
  });

  test("re-running is idempotent, not an error", () => {
    const home = tmp("cww-test-home-");
    const source = sourceSkill();
    const entry = path.join(home, ".claude", "skills", "cww");
    writeSkillEntry(skillEntryPlan(entry, source, false));
    expect(skillEntryPlan(entry, source, false)).toMatchObject({ action: "skip", reason: "already-linked" });
  });

  test("never overwrites the user's own skill of that name", () => {
    const home = tmp("cww-test-home-");
    const source = sourceSkill();
    const entry = path.join(home, ".claude", "skills", "cww");
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, "SKILL.md"), "mine");
    expect(skillEntryPlan(entry, source, false)).toMatchObject({ action: "skip", reason: "occupied" });
    expect(skillEntryPlan(entry, source, true)).toMatchObject({ action: "skip", reason: "occupied" });
    expect(fs.readFileSync(path.join(entry, "SKILL.md"), "utf8")).toBe("mine");
  });

  test("a link pointing elsewhere, and a broken link, both count as occupied", () => {
    const home = tmp("cww-test-home-");
    const source = sourceSkill();
    const skills = path.join(home, ".claude", "skills");
    fs.mkdirSync(skills, { recursive: true });

    const elsewhere = path.join(skills, "cww");
    fs.symlinkSync(sourceSkill(), elsewhere);
    expect(skillEntryPlan(elsewhere, source, false)).toMatchObject({ action: "skip", reason: "occupied" });

    const broken = path.join(skills, "cww2");
    fs.symlinkSync(path.join(home, "gone"), broken);
    expect(skillEntryPlan(broken, source, false)).toMatchObject({ action: "skip", reason: "occupied" });
  });
});

describe("the host skill in the install", () => {
  test("the skill folder ships with a SKILL.md", () => {
    expect(fs.existsSync(path.join(hostSkillDir(), "SKILL.md"))).toBe(true);
  });

  test("it declares the name the install entry uses", () => {
    const text = fs.readFileSync(path.join(hostSkillDir(), "SKILL.md"), "utf8");
    expect(text).toMatch(new RegExp(`^name:\\s*${HOST_SKILL_NAME}$`, "m"));
  });

  test("install.sh stages exactly the reference docs the built-in skill bundles", () => {
    // The list lives twice — here as BUILTIN_SKILL_REFERENCES (used at create
    // time) and in install.sh's staging loop (used for the host skill, which
    // is consumed in place). Adding a doc to one and not the other leaves the
    // host skill pointing at a file that isn't there.
    const install = fs.readFileSync(path.join(getCwwDir(), "install.sh"), "utf8");
    const loop = install.match(/^for doc in (.+); do$/m);
    expect(loop).not.toBeNull();
    expect(loop![1]!.split(/\s+/)).toEqual([...BUILTIN_SKILL_REFERENCES]);
  });

  test("every doc it references exists in docs/", () => {
    for (const name of BUILTIN_SKILL_REFERENCES) {
      expect(fs.existsSync(path.join(getCwwDir(), "docs", name))).toBe(true);
    }
  });
});

describe("tilde", () => {
  test("abbreviates paths under the given home and leaves others alone", () => {
    expect(tilde("/h/.claude/skills/cww", "/h")).toBe("~/.claude/skills/cww");
    expect(tilde("/opt/elsewhere", "/h")).toBe("/opt/elsewhere");
  });
});
