// Content checks for the built-in workspace skill (templates/skills/cww):
// valid frontmatter with a name matching its directory, and no dangling
// references — every references/<doc> the skill mentions must be a doc the
// registry actually bundles (BUILTIN_SKILL_REFERENCES, pulled from docs/).

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_SKILL_REFERENCES, getCwwDir } from "../src/agents/registry";

const SKILL_DIR = path.join(getCwwDir(), "templates", "skills", "cww");
const SKILL_MD = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

// The frontmatter block and its top-level "key: value" lines.
function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!;
  }
  return fields;
}

describe("built-in workspace skill", () => {
  test("has frontmatter with a name matching its directory and a description", () => {
    const fields = frontmatter(SKILL_MD);
    expect(fields.name).toBe(path.basename(SKILL_DIR));
    expect(fields.description?.length).toBeGreaterThan(0);
  });

  test("the description names the trigger surfaces (environment, cww itself)", () => {
    const description = frontmatter(SKILL_MD).description!;
    expect(description).toContain("cww");
    expect(description).toContain("environment");
  });

  test("every references/<doc> it mentions is bundled, and vice versa", () => {
    const mentioned = new Set(
      [...SKILL_MD.matchAll(/references\/([\w-]+\.md)/g)].map((m) => m[1]!),
    );
    expect([...mentioned].sort()).toEqual([...BUILTIN_SKILL_REFERENCES].sort());
  });

  test("every bundled reference doc exists in docs/", () => {
    for (const name of BUILTIN_SKILL_REFERENCES) {
      expect(fs.existsSync(path.join(getCwwDir(), "docs", name))).toBe(true);
    }
  });

  test("the skill folder ships no references/ of its own (assembled at create)", () => {
    expect(fs.existsSync(path.join(SKILL_DIR, "references"))).toBe(false);
  });
});
