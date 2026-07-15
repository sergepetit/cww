// cww __complete — hidden helper for the shell completion scripts (see
// completions/). Prints newline-separated candidates and nothing else. Must
// stay fast: it runs on every <TAB>, so no docker calls, no network.

import { CWW_AGENTS, agentAuthMethods, type Agent } from "../agents/registry";
import { findAllSessions, readSessionFile, type Session } from "../lib/session";

// Unique workspace names, with the same workspace->branch fallback that
// resolveWorkspace() applies to pre-rename sessions.
export function workspaceNames(sessions: Session[]): string[] {
  const names = new Set<string>();
  for (const session of sessions) {
    const name = session.workspace ?? session.branch;
    if (name) names.add(name);
  }
  return [...names].sort();
}

export function runComplete(argv: string[]): void {
  switch (argv[0]) {
    case "workspaces": {
      const sessions: Session[] = [];
      for (const file of findAllSessions()) {
        try {
          sessions.push(readSessionFile(file));
        } catch {
          // A corrupt session.json shouldn't break completion of the others.
        }
      }
      for (const name of workspaceNames(sessions)) console.log(name);
      break;
    }
    case "agents": {
      // From the registry (no I/O), so the completion scripts never hardcode
      // the agent list.
      for (const agent of CWW_AGENTS) console.log(agent);
      break;
    }
    case "auth-targets": {
      // 'cww auth' takes an agent name or the literal 'git'.
      for (const agent of CWW_AGENTS) console.log(agent);
      console.log("git");
      break;
    }
    case "auth-methods": {
      // 'cww auth <agent> --method <TAB>' — the agent's declared method ids.
      const agent = argv[1];
      if (!agent || !(CWW_AGENTS as readonly string[]).includes(agent)) process.exit(1);
      for (const m of agentAuthMethods(agent as Agent)) console.log(m.id);
      break;
    }
    default:
      // Unknown topic: exit quietly non-zero — completion scripts treat any
      // failure as "no candidates".
      process.exit(1);
  }
}
