// Placing one skill folder at a path, shared by the two commands that do it:
// 'cww export-skill' (host config -> <repo>/.cww/skills/<name>) and
// 'cww install-skill' (the install's built-in host skill -> a host agent's
// skills dir). Both link by default, snapshot with --copy, and never
// overwrite something that is already there — the rules live here so the two
// can't drift apart.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUnderHostPath, isWindows, sameHostPath } from "./paths";

export type SkillEntryPlan =
  | { action: "link"; path: string; target: string }
  | { action: "copy"; path: string; source: string }
  | { action: "skip"; path: string; reason: "already-linked" | "occupied" };

// What to do about `entry` given the skill folder `source`. Pure — the caller
// decides whether to report or write. "already-linked" is the idempotent
// re-run: the entry is a symlink that resolves to this very skill.
export function skillEntryPlan(entry: string, source: string, copy: boolean): SkillEntryPlan {
  const entryStat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (entryStat) {
    try {
      if (entryStat.isSymbolicLink() && sameHostPath(fs.realpathSync(entry), fs.realpathSync(source))) {
        return { action: "skip", path: entry, reason: "already-linked" };
      }
    } catch {
      // A broken symlink realpaths to nothing: treat as occupied below.
    }
    return { action: "skip", path: entry, reason: "occupied" };
  }
  return copy ? { action: "copy", path: entry, source } : { action: "link", path: entry, target: source };
}

// Carry out a non-skip plan. Symlink targets are absolute (an entry can point
// outside the tree it sits in), and copies dereference so a snapshot of a
// linked skill is real files. On Windows the link is a directory junction:
// a real symlink there needs admin rights or Developer Mode, a junction
// needs neither and reads back as a symlink.
export function writeSkillEntry(plan: SkillEntryPlan): void {
  if (plan.action === "skip") return;
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  if (plan.action === "copy") fs.cpSync(plan.source, plan.path, { recursive: true, dereference: true });
  else fs.symlinkSync(plan.target, plan.path, isWindows() ? "junction" : undefined);
}

// ~-abbreviate a host path for display.
export function tilde(p: string, home: string = os.homedir()): string {
  if (!isUnderHostPath(p, home)) return p;
  const rel = path.relative(home, p);
  return rel ? `~${path.sep}${rel}` : "~";
}
