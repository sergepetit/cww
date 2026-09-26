// cww install-skill — put the host-side cww skill into a coding agent's
// config on THIS machine, so the agent the user runs outside a workspace
// knows what cww is: how to set a repo up for it, how to author the repo's
// .cww/ files, and which commands are the user's to type.
//
// The inverse of 'cww export-skill' (host config -> project). Opt-in on
// purpose: the installer never writes into an agent's config by itself, and
// cww otherwise only ever *reads* those dirs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentHostSkillsDir,
  agentLabel,
  CWW_AGENTS,
  getCwwDir,
  validateAgent,
  type Agent,
} from "../agents/registry";
import { resolveAgent } from "../agents/registry";
import { loadEnvFile } from "../lib/env";
import { sameHostPath } from "../lib/paths";
import { skillEntryPlan, tilde, writeSkillEntry } from "../lib/skill-link";
import { die, info, success, warn } from "../lib/ui";
import { parseCommandArgs } from "./common";

const USAGE = `Usage: cww install-skill [agent] [options]

Install the host-side cww skill into a coding agent's config on this machine,
so the agent knows how to set repos up for cww and drive workspaces for you.
It is linked, not copied, so updating cww updates the skill.

This is the host counterpart of the skill every workspace already carries;
nothing here is needed for workspaces themselves to work.

Arguments:
  agent             Agent config to install into: claude | vibe | opencode |
                    copilot | pi (default: CWW_AGENT from ~/.cww/env, else claude)

Options:
  --all             Install into every agent config that supports skills
  --copy            Copy instead of linking (a snapshot that stops following
                    the installed version)
  --remove          Remove a previously installed skill instead
  -h, --help        Show this help message

Examples:
  cww install-skill                # Into your default agent's config
  cww install-skill opencode       # Into ~/.config/opencode/skills
  cww install-skill --all          # Every agent config on this machine
  cww install-skill --remove       # Take it back out
`;

// The skill folder inside the install. install.sh stages its references/ as
// symlinks into the install's docs/, so the folder is consumed in place.
export function hostSkillDir(): string {
  return path.join(getCwwDir(), "templates", "skills", "cww-host");
}

// The entry an agent's host config gets. 'cww' matches the in-workspace
// skill's name deliberately: an agent never sees both at once (one is on the
// host, one is inside a container), and the shared name keeps "the cww skill"
// unambiguous when the user talks about it.
export const HOST_SKILL_NAME = "cww";

export interface InstallTarget {
  agent: Agent;
  dir: string | null; // the agent's host skills dir, null when it declares none
  entry: string | null; // <dir>/cww
}

// Where the skill would land for each requested agent. Pure, so tests cover
// the routing without touching a real config dir.
export function installTargets(agents: readonly Agent[], home: string = os.homedir()): InstallTarget[] {
  return agents.map((agent) => {
    const dir = agentHostSkillsDir(agent, home);
    return { agent, dir, entry: dir ? path.join(dir, HOST_SKILL_NAME) : null };
  });
}

// Install into one agent's config. Returns whether the skill is now there.
function install(target: InstallTarget, source: string, copy: boolean): boolean {
  if (!target.entry) {
    info(`${agentLabel(target.agent)}: no host skills dir — skipped.`);
    return false;
  }
  // The agent's config dir is the agent's business, but a user who has never
  // written a personal skill has no skills/ yet; refusing over that is
  // friction with no safety value.
  const plan = skillEntryPlan(target.entry, source, copy);
  if (plan.action === "skip") {
    if (plan.reason === "already-linked") {
      info(`${agentLabel(target.agent)}: already installed at ${tilde(target.entry)}.`);
      return true;
    }
    warn(
      `${agentLabel(target.agent)}: ${tilde(target.entry)} already exists and isn't cww's — not overwriting. ` +
        `Remove it first, or keep your own skill of that name.`,
    );
    return false;
  }
  writeSkillEntry(plan);
  if (plan.action === "copy") {
    success(`${agentLabel(target.agent)}: copied to ${tilde(target.entry)} (a snapshot — cww updates won't reach it).`);
  } else {
    success(`${agentLabel(target.agent)}: linked ${tilde(target.entry)} -> ${tilde(plan.target)}`);
  }
  return true;
}

// Remove one agent's copy — but only ours. A user's own 'cww' skill, or a
// --copy snapshot they have since edited, is left alone: we can recognise the
// link we made, and a copy we cannot, so a copy is reported rather than
// deleted.
function remove(target: InstallTarget, source: string): boolean {
  if (!target.entry) return false;
  const stat = fs.lstatSync(target.entry, { throwIfNoEntry: false });
  if (!stat) {
    info(`${agentLabel(target.agent)}: nothing installed.`);
    return false;
  }
  if (!stat.isSymbolicLink()) {
    warn(`${agentLabel(target.agent)}: ${tilde(target.entry)} is a real directory, not cww's link — leaving it alone.`);
    return false;
  }
  // A link pointing elsewhere isn't ours; a broken one (install dir already
  // deleted) is, and removing it is the whole point of --remove.
  let resolved: string | null = null;
  try {
    resolved = fs.realpathSync(target.entry);
  } catch {
    resolved = null;
  }
  if (resolved && !sameHostPath(resolved, fs.realpathSync(source))) {
    warn(`${agentLabel(target.agent)}: ${tilde(target.entry)} links somewhere else — leaving it alone.`);
    return false;
  }
  fs.unlinkSync(target.entry);
  success(`${agentLabel(target.agent)}: removed ${tilde(target.entry)}`);
  return true;
}

export async function runInstallSkill(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, USAGE, {
    all: { type: "boolean", default: false },
    copy: { type: "boolean", default: false },
    remove: { type: "boolean", default: false },
  });
  if (!args) return;
  const { all, copy, remove: removing } = args.values;
  const [agentArg] = args.positionals;

  if (all && agentArg) die("Pass an agent or --all, not both.");
  if (copy && removing) die("--copy and --remove do nothing together.");

  let agents: readonly Agent[];
  if (all) {
    agents = CWW_AGENTS;
  } else if (agentArg) {
    validateAgent(agentArg);
    agents = [agentArg];
  } else {
    // Same default as init/create: CWW_AGENT out of ~/.cww/env, else claude.
    loadEnvFile(path.join(os.homedir(), ".cww", "env"));
    agents = [resolveAgent()];
  }

  const source = hostSkillDir();
  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    die(`The host skill is missing from the install (${source}). Re-run install.sh.`);
  }
  if (!removing && !fs.existsSync(path.join(source, "references"))) {
    // Staged by install.sh, not checked into the skill folder — a running
    // copy without it means someone is running from a source tree.
    warn(`The skill's references/ is missing (${tilde(source)}/references); its bundled docs won't resolve.`);
  }

  const targets = installTargets(agents);
  let done = 0;
  for (const target of targets) {
    if (removing) {
      if (remove(target, source)) done++;
    } else if (install(target, source, copy)) done++;
  }

  if (done === 0) return;
  if (removing) return;
  info("Agents discover skills at session start — restart yours before it triggers.");
}
