// cww auth — store or renew credentials. Two kinds live in two stores: agent
// auth tokens are user-wide (~/.cww/env; each workspace receives only the
// single key of the auth method it was created with — see
// docs/agent-env-scoping-plan.md) and the git credential is per-repo
// (~/.cww/credentials). cww never mints a
// token — the user generates it ('claude setup-token', the forge's web UI);
// auth guides, validates, stores, and reports which workspaces pick the new
// value up when (stopped: next start, via the start-time secret refresh;
// running: after a stop + start, the agent process must relaunch).

import { parseArgs } from "node:util";
import {
  CWW_AGENTS,
  agentAuthMethods,
  agentLabel,
  allAuthEnvKeys,
  resolveAgent,
  type Agent,
} from "../agents/registry";
import type { AgentAuthMethod } from "../agents/types";
import { globalEnvFile, promptStoreMethodSecret, storeEnvValue } from "../lib/auth-flow";
import { loadCredentials, matchCredential } from "../lib/credentials";
import { containerRunning } from "../lib/docker";
import { loadEnvFile } from "../lib/env";
import { getGitRoot, isGitRepo } from "../lib/git";
import { resolveProjectPath } from "../lib/paths";
import { findAllSessions, readSessionFile, type Session } from "../lib/session";
import { setupRepo } from "../lib/setup";
import { die, info, promptChoice, warn } from "../lib/ui";

const USAGE = `Usage: cww auth [<agent>|git|KEY=VALUE] [options]

Store or renew a credential:
  cww auth                 Default agent's token (CWW_AGENT, falling back to claude)
  cww auth claude          Claude Code OAuth token (from 'claude setup-token')
  cww auth opencode        OpenCode provider key (pick which, or use --method)
  cww auth copilot         Copilot GitHub token (fine-grained PAT / gho_ token),
                           or a BYOK endpoint key via --method provider-key
  cww auth git             This repo's git credential — same flow as 'cww init',
                           validated with 'git ls-remote' before it is stored
  cww auth KEY=VALUE       Non-interactive: upsert one line into ~/.cww/env

Agent tokens are user-wide (~/.cww/env, mode 600); the git credential is
per-repo (~/.cww/credentials). A workspace receives only the key of the auth
method it was created with ('cww create --auth'). Existing workspaces pick a
new value up on their next start ('cww start'/'attach'/'shell'); running ones
need 'cww stop' + 'cww start' first — the agent process must relaunch.

Options:
  --method <m>     Which of the agent's auth methods to store (default: the
                   agent's first; tab-completes per agent)
  -h, --help       Show this help message

Examples:
  cww auth                                  # renew the default agent's token
  cww auth opencode --method openai-api-key
  cww auth copilot --method provider-key    # key for a BYOK endpoint
  cww auth git                              # rotate this repo's PAT
`;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Does this workspace receive the given env key? A recorded auth method
// answers exactly (only its own key is injected — env scoping); older
// sessions fall back to "any of the agent's declared keys", and ones with no
// (or an unknown) recorded agent are included — better a spurious restart
// hint than a missed one.
function usesKey(session: Session, key: string): boolean {
  const agent = typeof session.agent === "string" ? session.agent : "";
  if (!(CWW_AGENTS as readonly string[]).includes(agent)) return true;
  const methods = agentAuthMethods(agent as Agent);
  if (typeof session.auth === "string") {
    const method = methods.find((m) => m.id === session.auth);
    if (method) return method.envKey === key;
  }
  return methods.some((m) => m.envKey === key);
}

// Tell the user which existing workspaces the new credential reaches, and
// when: stopped ones on their next start (the start-time secret refresh),
// running ones only after a restart (the agent process holds the old value).
async function reportWorkspaces(affects: (session: Session) => boolean): Promise<void> {
  const stopped: string[] = [];
  const running: string[] = [];
  for (const file of findAllSessions()) {
    let session: Session;
    try {
      session = readSessionFile(file);
    } catch {
      continue; // corrupt session.json — other commands complain about it
    }
    if (!affects(session)) continue;
    const name = session.workspace ?? session.branch;
    if (!name || !session.container) continue;
    ((await containerRunning(session.container)) ? running : stopped).push(name);
  }
  if (stopped.length === 0 && running.length === 0) {
    info("No existing workspaces use this credential.");
    return;
  }
  console.log("");
  if (stopped.length > 0) {
    info(`Stopped workspace(s) pick it up on their next start: ${stopped.join(", ")}`);
  }
  if (running.length > 0) {
    warn("Running workspace(s) keep the old value until restarted:");
    for (const ws of running) console.log(`    cww stop ${ws} && cww start ${ws}`);
  }
}

// --- Targets -----------------------------------------------------------------

// Non-interactive KEY=VALUE upsert.
async function authKeyValue(arg: string): Promise<void> {
  const eq = arg.indexOf("=");
  const key = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (!KEY_RE.test(key)) die(`Invalid env key: '${key}'`);
  if (!value) die(`Empty value for ${key} — nothing stored.`);
  const isAuthKey = allAuthEnvKeys().includes(key);
  storeEnvValue(key, value);
  if (!isAuthKey) {
    warn(`${key} is not an agent auth key: existing workspaces get it only when`);
    warn("recreated (the start-time refresh forwards agent tokens and the git");
    warn("credential only); newly created ones see it right away.");
    return;
  }
  await reportWorkspaces((s) => usesKey(s, key));
}

// The current repo's git credential — 'cww init's setup flow (prompt with the
// stored URL/user as defaults, validate with 'git ls-remote', persist), then
// the workspace pickup report.
async function authGit(): Promise<void> {
  let projectPath = resolveProjectPath(undefined);
  if (!(await isGitRepo(projectPath))) {
    die(`Not a git repository: ${projectPath} — run 'cww auth git' inside the repo.`);
  }
  const gitRoot = await getGitRoot(projectPath);
  if (gitRoot && gitRoot !== projectPath) {
    info(`Using git root: ${gitRoot}`);
    projectPath = gitRoot;
  }
  const cloneUrl = await setupRepo(projectPath);
  const entries = loadCredentials();
  const cred = matchCredential(entries, cloneUrl);
  if (!cred) return; // public repo, no token stored — nothing to propagate
  await reportWorkspaces(
    (s) => typeof s.repoUrl === "string" && matchCredential(entries, s.repoUrl)?.url === cred.url,
  );
}

// An agent's token: pick the method (only ones that store a secret — the
// keyless none/config-file methods have nothing to renew), walk through
// obtaining it, prompt for the paste, store, report.
async function authAgent(agent: Agent, methodArg?: string): Promise<void> {
  const storable = agentAuthMethods(agent).filter((m) => m.envKey);
  if (storable.length === 0) die(`${agentLabel(agent)} declares no auth methods that store a credential.`);

  let method: AgentAuthMethod;
  if (methodArg) {
    const found = agentAuthMethods(agent).find((m) => m.id === methodArg);
    if (!found) {
      die(
        `Unknown method '${methodArg}' for ${agentLabel(agent)} (available: ${agentAuthMethods(agent).map((m) => m.id).join(", ")})`,
      );
    }
    if (!found.envKey) {
      die(`Method '${methodArg}' stores no credential — there is nothing to renew for it.`);
    }
    method = found;
  } else if (storable.length === 1) {
    method = storable[0]!;
  } else {
    const choice = promptChoice(
      `Which ${agentLabel(agent)} credential?`,
      storable.map((m) => `${m.id} (${m.envKey})`),
    );
    if (choice === 0) die("No method selected.");
    method = storable[choice - 1]!;
  }

  await promptStoreMethodSecret(agent, method);
  await reportWorkspaces((s) => usesKey(s, method.envKey!));
}

// --- Command -------------------------------------------------------------------

export async function runAuth(argv: string[]): Promise<void> {
  let target: string | undefined;
  let methodArg: string | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h", default: false },
        method: { type: "string" },
      },
      allowPositionals: true,
    });
    if (parsed.values.help) {
      console.log(USAGE);
      return;
    }
    methodArg = parsed.values.method;
    if (parsed.positionals.length > 1) die(`Unexpected argument: ${parsed.positionals[1]}`);
    target = parsed.positionals[0];
  } catch (e) {
    die(e instanceof Error ? e.message.split("\n")[0]! : String(e));
  }

  // Agent tokens live in the global env; load it so CWW_AGENT resolves and
  // the stored defaults are visible to the flows below.
  loadEnvFile(globalEnvFile());

  if (target?.includes("=")) {
    if (methodArg) die("--method does not apply to a KEY=VALUE upsert.");
    await authKeyValue(target);
    return;
  }
  if (target === "git") {
    if (methodArg) die("--method does not apply to the git credential.");
    await authGit();
    return;
  }
  if (target && !(CWW_AGENTS as readonly string[]).includes(target)) {
    die(
      `Unknown target '${target}' (expected an agent — ${CWW_AGENTS.join(", ")} — 'git', or KEY=VALUE)`,
    );
  }
  await authAgent(resolveAgent(target || undefined), methodArg);
}
