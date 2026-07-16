// cww export-skill — share one personal skill from the host's agent config
// with a project: a symlink into <repo>/.cww/skills/ so future creates carry
// it, plus a live copy into the project's running workspaces (the create-time
// mechanism can't reach those). Skills are the portable Agent Skills format
// (agentskills.io), so a skill found in one agent's host config loads into
// whichever agent a workspace runs.

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  agentContainerSkillsDir,
  agentHostSkillsDir,
  agentLabel,
  CWW_AGENTS,
  validateAgent,
  type Agent,
} from "../agents/registry";
import { copyDirIntoContainer } from "../lib/container-fs";
import { containerRunning } from "../lib/docker";
import { getGitRoot } from "../lib/git";
import { findRepoWorkspaces, resolveWorkspace, type WorkspaceRef } from "../lib/session";
import { die, error, info, success, warn } from "../lib/ui";

const USAGE = `Usage: cww export-skill [skill-name] [workspace-name] [options]

Share a personal skill from your host agent config (~/.claude/skills, ...)
with the current project: symlinks it into the project's .cww/skills/ (so
future creates carry it) and copies it into the project's running workspaces.
With no arguments, lists the skills available to export.

Arguments:
  skill-name       Skill folder to export (omit to list what's exportable)
  workspace-name   Only inject into this workspace (default: all of the
                   current repo's workspaces)

Options:
  --from <agent>   Host agent config to take the skill from (claude | vibe |
                   opencode); needed only when several configs have the name
  --copy           Copy into .cww/skills/ instead of symlinking (a snapshot
                   that no longer follows the host version)
  -h, --help       Show this help message

Examples:
  cww export-skill                          # List exportable skills
  cww export-skill organize-docs            # Export to this repo + workspaces
  cww export-skill organize-docs sandbox    # ... only into 'sandbox'
  cww export-skill deploy --from claude     # Disambiguate the source config
`;

export interface HostSkill {
  agent: Agent;
  name: string;
  dir: string; // the skill folder itself (contains SKILL.md)
  description: string; // frontmatter description, "" when unreadable
}

// The one-line frontmatter `description:` of a SKILL.md, "" when the file or
// field is missing (same lenient shape as tests/skill.test.ts's parser).
function skillDescription(skillDir: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return "";
  }
  const block = text.match(/^---\n([\s\S]*?)\n---\n/);
  const line = block?.[1]?.match(/^description:\s*(.*)$/m);
  return line?.[1]?.trim() ?? "";
}

// Every <name>/SKILL.md skill folder under the agents' host skills dirs, in
// registration order then by name. Pure FS scanning — also feeds completion.
export function listHostSkills(home: string = os.homedir()): HostSkill[] {
  const skills: HostSkill[] = [];
  for (const agent of CWW_AGENTS) {
    const dir = agentHostSkillsDir(agent, home);
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const skillDir = path.join(dir, entry.name);
      // Dirent.isDirectory() is false for symlinked skill folders; stat the
      // SKILL.md instead so linked skills export like real ones.
      if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) continue;
      skills.push({ agent, name: entry.name, dir: skillDir, description: skillDescription(skillDir) });
    }
  }
  return skills;
}

// The host copies of one named skill, optionally restricted to one agent's
// config dir. More than one hit means the user must pick with --from.
export function findSkillSources(name: string, from?: Agent, home: string = os.homedir()): HostSkill[] {
  return listHostSkills(home).filter((s) => s.name === name && (!from || s.agent === from));
}

export type LinkPlan =
  | { action: "link"; path: string; target: string }
  | { action: "copy"; path: string; source: string }
  | {
      action: "skip";
      path: string;
      reason: "covered-by-linked-dir" | "linked-dir" | "already-linked" | "occupied";
    };

// What the persistent half should do to <repo>/.cww/skills. Never writes
// through a symlinked .cww/skills (that would edit the host config it points
// at), and never overwrites an existing entry.
export function linkPlan(projectPath: string, skill: { name: string; dir: string }, copy: boolean): LinkPlan {
  const skillsDir = path.join(projectPath, ".cww", "skills");
  const entry = path.join(skillsDir, skill.name);
  if (fs.lstatSync(skillsDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    // The whole-dir trick (.cww/skills -> ~/.claude/skills): existsSync
    // follows the dir symlink, so it tells us whether the linked config
    // already exposes this skill.
    const covered = fs.existsSync(path.join(entry, "SKILL.md"));
    return { action: "skip", path: entry, reason: covered ? "covered-by-linked-dir" : "linked-dir" };
  }
  const entryStat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (entryStat) {
    try {
      if (entryStat.isSymbolicLink() && fs.realpathSync(entry) === fs.realpathSync(skill.dir)) {
        return { action: "skip", path: entry, reason: "already-linked" };
      }
    } catch {
      // A broken symlink realpaths to nothing: treat as occupied below.
    }
    return { action: "skip", path: entry, reason: "occupied" };
  }
  return copy
    ? { action: "copy", path: entry, source: skill.dir }
    : { action: "link", path: entry, target: skill.dir };
}

export interface InjectionTarget {
  workspace: string;
  container: string;
  agent: string;
  dest: string | null; // null = the agent maps no container skills dir
}

// Where the skill lands in one workspace's container. Running-state and the
// copy itself are the caller's (Docker) business — this stays pure.
export function injectionTarget(ws: WorkspaceRef, name: string): InjectionTarget {
  const agent = (ws.session.agent as string | undefined) ?? "claude";
  const skillsDir = agentContainerSkillsDir(agent);
  return {
    workspace: ws.workspace,
    container: ws.container,
    agent,
    dest: skillsDir ? path.posix.join(skillsDir, name) : null,
  };
}

// ~-abbreviate a host path for display.
function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function printSkillList(from?: Agent): void {
  const skills = listHostSkills().filter((s) => !from || s.agent === from);
  if (skills.length === 0) {
    const dirs = (from ? [from] : CWW_AGENTS)
      .map((a) => agentHostSkillsDir(a))
      .filter((d): d is string => !!d)
      .map(tilde);
    warn(`No exportable skills found (searched ${dirs.join(", ")}).`);
    return;
  }
  const nameWidth = Math.max(...skills.map((s) => s.name.length));
  const dirWidth = Math.max(...skills.map((s) => tilde(path.dirname(s.dir)).length));
  for (const s of skills) {
    const dir = tilde(path.dirname(s.dir));
    console.log(`${s.name.padEnd(nameWidth)}  ${dir.padEnd(dirWidth)}  ${s.description}`);
  }
  console.log();
  info("Export one with 'cww export-skill <name>'.");
}

// Execute the persistent half and report what happened. Returns whether
// .cww/skills now (or already) carries the skill for future creates.
async function applyLinkPlan(projectPath: string, skill: HostSkill, copy: boolean): Promise<boolean> {
  const plan = linkPlan(projectPath, skill, copy);
  const rel = path.relative(projectPath, plan.path);
  if (plan.action === "skip") {
    switch (plan.reason) {
      case "covered-by-linked-dir":
        info(`${rel} already comes in via your .cww/skills symlink; nothing to record.`);
        return true;
      case "linked-dir":
        warn(
          `.cww/skills is a symlink into your host config — not writing through it. ` +
            `The skill is NOT recorded for future creates.`,
        );
        return false;
      case "already-linked":
        info(`${rel} already links to this skill; nothing to record.`);
        return true;
      case "occupied":
        warn(`${rel} already exists and isn't a link to this skill — not overwriting. Remove it first to re-export.`);
        return false;
    }
  }
  fs.mkdirSync(path.dirname(plan.path), { recursive: true });
  if (plan.action === "copy") {
    fs.cpSync(plan.source, plan.path, { recursive: true, dereference: true });
    success(`Copied the skill to ${rel} (a snapshot — it won't follow the host version).`);
  } else {
    fs.symlinkSync(plan.target, plan.path);
    success(`Linked ${rel} -> ${tilde(plan.target)} (future creates carry it).`);
  }
  // Personal-tier assets are usually gitignored; a committed absolute symlink
  // into ~ is broken for teammates. check-ignore: 0 ignored, 1 not, 128 error
  // (best-effort — stay quiet on anything but a clear "not ignored").
  const r = await $`git -C ${projectPath} check-ignore -q ${plan.path}`.quiet().nothrow();
  if (r.exitCode === 1) {
    warn(`${rel} isn't gitignored — it would be committed. Consider adding '.cww/' to .gitignore.`);
  }
  return true;
}

export async function runExportSkill(argv: string[]): Promise<void> {
  let name: string | undefined;
  let wsName: string | undefined;
  let from: Agent | undefined;
  let copy = false;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        copy: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    if (values.from) {
      validateAgent(values.from);
      from = values.from;
    }
    copy = values.copy ?? false;
    [name, wsName] = positionals;
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  if (!name) {
    printSkillList(from);
    return;
  }

  // The skill on the host.
  const sources = findSkillSources(name, from);
  if (sources.length === 0) {
    const dirs = (from ? [from] : CWW_AGENTS)
      .map((a) => agentHostSkillsDir(a))
      .filter((d): d is string => !!d)
      .map(tilde);
    die(`No skill '${name}' found (searched ${dirs.join(", ")}).`);
  }
  if (sources.length > 1) {
    error(`Skill '${name}' exists in several host configs:`);
    for (const s of sources) console.error(`  --from ${s.agent}  (${tilde(s.dir)})`);
    die("Pick one with --from.");
  }
  const skill = sources[0]!;
  info(`Exporting '${name}' from ${tilde(path.dirname(skill.dir))}`);
  if (name === "cww") {
    warn("A skill named 'cww' shadows the built-in cww workspace skill.");
  }

  // The project it belongs to, and the workspaces to inject into.
  let projectPath: string | null;
  let targets: WorkspaceRef[];
  if (wsName) {
    const ws = await resolveWorkspace(wsName);
    if (!ws) {
      error(`No workspace found: ${wsName}`);
      console.log(USAGE);
      process.exit(1);
    }
    targets = [ws];
    projectPath = (ws.session.mainRepo as string | undefined) ?? (await getGitRoot(process.cwd()));
  } else {
    projectPath = await getGitRoot(process.cwd());
    if (!projectPath) {
      die("Not inside a git repository. Run from the project's repo, or name a workspace.");
    }
    targets = findRepoWorkspaces(projectPath);
  }

  // Persistent half: record it in <repo>/.cww/skills for future creates.
  if (projectPath) {
    await applyLinkPlan(projectPath, skill, copy);
  } else {
    warn("Could not determine the project repo; the skill is NOT recorded for future creates.");
  }

  // Live half: copy into the running workspaces.
  if (targets.length === 0) {
    info("This repo has no workspaces yet — the skill will load at the next 'cww create'.");
    return;
  }
  let injected = 0;
  for (const ws of targets) {
    const t = injectionTarget(ws, name);
    if (!t.dest) {
      info(`${t.workspace}: personal skills aren't supported by ${agentLabel(t.agent)}; skipped.`);
      continue;
    }
    if (!t.container || !(await containerRunning(t.container))) {
      info(`${t.workspace}: not running; skipped (a recreate picks the skill up from .cww/skills).`);
      continue;
    }
    // docker cp merges rather than syncs: flag an overwrite so stale files
    // from a previous version don't masquerade as a clean copy.
    const existed = (await $`docker exec ${t.container} test -e ${t.dest}`.quiet().nothrow()).exitCode === 0;
    if (await copyDirIntoContainer(skill.dir, t.container, t.dest)) {
      const note = existed ? " — replaced an existing copy; files deleted on the host may linger" : "";
      success(`${t.workspace}: skill loaded (${t.dest.replace("/home/developer", "~")})${note}`);
      injected++;
    } else {
      warn(`${t.workspace}: could not read ${tilde(skill.dir)}; skipped.`);
    }
  }
  if (injected > 0) {
    info("Agents discover skills at session start — a running agent may need a new session before the skill triggers.");
  }
}
