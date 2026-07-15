// cww create — create a workspace: a container that clones the repo and runs
// the app's services. The workspace is identified by a NAME you choose; git
// inside it (branches, rebases, pushes) is entirely yours — cww dictates none.

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentContainerEnv,
  agentLabel,
  agentPreflight,
  agentImage,
  ensureAgentImage,
  getCwwDir,
  materializeCwwAssets,
  resolveAgent,
  validateAgent,
  type Agent,
} from "../agents/registry";
import { browserEnabled } from "../lib/config";
import {
  attachAgentSession,
  containerExists,
  containerRunning,
  provisionCacheDir,
  runResetScript,
  startTaskStack,
  taskCompose,
} from "../lib/docker";
import { loadEnvFile } from "../lib/env";
import { writeTaskEnv } from "../lib/env-refresh";
import { getCurrentBranch, getGitRoot, isGitRepo } from "../lib/git";
import { hostsEntries } from "../lib/hosts";
import { setupRepo } from "../lib/setup";
import { getProjectConfig } from "../lib/user-config";
import { containerHostname, getContainerName, getTaskDir, normalizeGitUrl } from "../lib/naming";
import { resolveProjectPath } from "../lib/paths";
import { readSession, writeSession } from "../lib/session";
import { confirm, die, error, info, success, warn } from "../lib/ui";

const USAGE = `Usage: cww create [project-path] <workspace-name> [options]

Create a workspace: a container that clones the repo and brings up the app's
services. You choose the workspace NAME; it identifies the workspace for every
other command. Git inside the workspace is yours — branch, rebase, and push
however you like; cww does not impose a workflow.

Arguments:
  project-path      Path to the git repository (default: current directory)
  workspace-name    Name for the workspace (e.g. sandbox, review, my-feature)

The first create in a repo runs the setup flow inline (clone URL + git
credential, validated with 'git ls-remote' and stored in ~/.cww/config.json
and ~/.cww/credentials); later creates reuse it. Re-run setup — e.g. to
rotate a token — with 'cww init'.

Options:
  --branch <ref>    Branch to check out inside the workspace
                    (default: the branch you're currently on; a name that
                    doesn't exist upstream is created fresh)
  --ref <ref>       Alias for --branch
  --agent <name>    Coding agent to run in the workspace: claude | vibe | opencode
                    (default: this project's agent in ~/.cww/config.json,
                    then CWW_AGENT from ~/.cww/env, falling back to claude)
  --remote <name>   Git remote whose URL the workspace clones — a
                    per-invocation override of the project's configured URL
                    (default: origin)
  --no-attach       Don't attach to tmux after creating
  -h, --help        Show this help message

Examples:
  cww create sandbox                  # From within a git repo
  cww create . sandbox                # Explicit current directory
  cww create /path/to/project review  # With full project path
  cww create sandbox --branch main    # Start on a specific branch
  cww create sandbox --agent vibe     # Run Mistral Vibe instead of the default agent
`;

// --- Pure helpers (exported for tests) --------------------------------------

// Host dirs under ~/.cww/cache that a services file declares as mount sources
// ("${HOME}/.cww/cache/<...>:<container-path>"), expanded against home.
export function declaredCacheDirs(servicesYaml: string, home: string): string[] {
  const matches = servicesYaml.match(/(\$\{HOME\}|\$HOME)\/\.cww\/cache\/[^:"\s]+/g) ?? [];
  return [...new Set(matches)].sort().map((src) => src.replace(/^\$\{HOME\}|^\$HOME/, home));
}

// Fill {{PLACEHOLDER}}s. Unknown placeholders are left as-is, like sed did.
export function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

// --- Compose generation ------------------------------------------------------

interface TaskParams {
  taskDir: string;
  containerName: string;
  workspaceName: string;
  branchName: string;
  agent: Agent;
  repoUrl: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  projectPath: string;
}

// Generate docker-compose.yml from the template into the task dir.
function generateCompose(p: TaskParams): void {
  const template = fs.readFileSync(
    path.join(getCwwDir(), "templates", "docker-compose.yml.template"),
    "utf8",
  );
  const rendered = renderTemplate(template, {
    TASK_DIR: p.taskDir,
    CONTAINER_NAME: p.containerName,
    CONTAINER_HOSTNAME: containerHostname(p.containerName),
    CWW_IMAGE: agentImage(p.agent),
    WORKSPACE_NAME: p.workspaceName,
    BRANCH_NAME: p.branchName,
    REPO_URL: p.repoUrl,
    GIT_AUTHOR_NAME: p.gitAuthorName,
    GIT_AUTHOR_EMAIL: p.gitAuthorEmail,
    CWW_BROWSER: process.env.CWW_BROWSER || "on",
    HOME: os.homedir(),
  });
  fs.writeFileSync(path.join(p.taskDir, "docker-compose.yml"), rendered);
}

// Render an optional extra_hosts override for the container's /etc/hosts from
// user-maintained host files (global ~/.cww/hosts and per-project
// <repo>/.cww/hosts). Useful for internal VCS/registry hosts the container's
// DNS can't resolve on its own.
function generateHostsOverride(taskDir: string, projectPath: string): void {
  const out = path.join(taskDir, "docker-compose.hosts.yml");
  const entries = hostsEntries(projectPath);
  if (entries.length > 0) {
    const lines = entries.map((e) => `      - "${e.host}:${e.ip}"`);
    fs.writeFileSync(out, `services:\n  coder:\n    extra_hosts:\n${lines.join("\n")}\n`);
    info(`Adding ${entries.length} extra host(s) to the container`);
  } else {
    fs.rmSync(out, { force: true });
  }
}

// Render the override publishing the built-in browser's noVNC port (default
// on; CWW_BROWSER=off in ~/.cww/env — or a project "browser": "off" in
// ~/.cww/config.json — skips it, and the
// entrypoint then also skips launching the browser stack — the flag reaches it
// via the {{CWW_BROWSER}} template env). Kept out of the main template so a
// disabled browser publishes no dead port. Loopback-only with a
// Docker-assigned host port, so it rides 'cww list' / 'cww tunnel-command'
// like any service port.
function generateBrowserOverride(taskDir: string): void {
  const out = path.join(taskDir, "docker-compose.browser.yml");
  if (!browserEnabled()) {
    fs.rmSync(out, { force: true });
    return;
  }
  fs.writeFileSync(
    out,
    `# Generated by cww - do not edit manually
services:
  coder:
    ports:
      - "127.0.0.1::7900"   # noVNC for the built-in browser
`,
  );
  info("Built-in browser enabled (noVNC on container port 7900; CWW_BROWSER=off disables)");
}

// Render the override that sets agent-provided extra env vars on the
// container (from the agent's containerEnv hook, e.g. opencode's personal
// config file). Compose's 'environment:' section overrides the env_file, so
// these entries beat a leftover line in ~/.cww/env. Each entry is emitted as
// a YAML double-quoted scalar via JSON.stringify — JSON string escaping is
// valid YAML — with '$' doubled so compose interpolation passes the value
// through verbatim.
export function generateAgentEnvOverride(taskDir: string, entries: Record<string, string>): void {
  const out = path.join(taskDir, "docker-compose.agent.yml");
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    fs.rmSync(out, { force: true });
    return;
  }
  const lines = keys.map(
    (key) => `      - ${JSON.stringify(`${key}=${entries[key]}`).split("$").join("$$")}`,
  );
  fs.writeFileSync(
    out,
    `# Generated by cww - do not edit manually\nservices:\n  coder:\n    environment:\n${lines.join("\n")}\n`,
  );
}

// Bring the task's compose stack up, layering any override files present.
async function composeUp(taskDir: string): Promise<void> {
  const code = await taskCompose(taskDir, ["up", "-d"]);
  if (code !== 0) process.exit(code);
}

// --- Cache provisioning around create ----------------------------------------

// Provision any dependency-cache dir the project declares under ~/.cww/cache,
// so a declared cache "just works" on create without a separate `cww cache`
// step. Only touches dirs that don't exist yet — already-provisioned caches
// (and their ownership) are left untouched, keeping this cheap on every
// create.
async function provisionDeclaredCaches(servicesFile: string): Promise<void> {
  let yaml: string;
  try {
    yaml = fs.readFileSync(servicesFile, "utf8");
  } catch {
    return;
  }
  for (const dir of declaredCacheDirs(yaml, os.homedir())) {
    if (fs.existsSync(dir)) continue;
    info(`Provisioning declared cache: ${dir}`);
    if (!(await provisionCacheDir(dir))) {
      warn(`Could not provision ${dir}; that cache mount may not be writable inside the workspace.`);
    }
  }
}

// Advisory nudge: if the repo has a known dependency manifest but no matching
// shared cache is mounted, suggest the relevant `cww cache` preset.
function suggestCaches(projectPath: string, servicesFile: string): void {
  let declared = "";
  try {
    declared = fs.readFileSync(servicesFile, "utf8");
  } catch {
    // no services file — every manifest found below yields a tip
  }
  const has = (file: string) => fs.existsSync(path.join(projectPath, file));
  const tips: string[] = [];
  if (has("package.json") && !declared.includes(".npm/_cacache")) tips.push("Node/npm: cww cache npm");
  if (has("pom.xml") && !declared.includes(".m2/repository")) tips.push("Maven:    cww cache m2");
  if (has("build.sbt") && !/coursier|\.ivy2/.test(declared))
    tips.push("sbt:      cww cache coursier  (add ivy2 too)");
  if ((has("build.gradle") || has("build.gradle.kts")) && !declared.includes("gradle/caches"))
    tips.push("Gradle:   cww cache gradle");
  if (tips.length === 0) return;
  info("Tip: share a dependency cache across workspaces to speed up installs —");
  for (const t of tips) console.log(`        ${t}`);
  console.log("        then add the printed volume line to .cww/docker-compose.services.yml");
}

// --- Bring-up ------------------------------------------------------------------

// Poll for the in-container tmux session. The entrypoint clones the repo
// before starting tmux, so the session appearing is a proxy for "clone
// finished."
async function waitForSession(container: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const r = await $`docker exec ${container} tmux has-session -t main`.quiet().nothrow();
    if (r.exitCode === 0) return true;
    await Bun.sleep(1000);
  }
  return false;
}

// The entrypoint leaves this marker when the in-container clone/checkout
// failed (details in /workspace/cww.log). The tmux session then runs less over
// the log instead of the agent.
async function setupFailed(container: string): Promise<boolean> {
  const r = await $`docker exec ${container} test -f /tmp/cww-setup-failed`.quiet().nothrow();
  return r.exitCode === 0;
}

// Once the workspace is up: load any personal .cww assets, run the optional
// reset/seed script, then attach (or print how to). Used for fresh creates and
// for recreating a workspace whose container was removed — both start from a
// clean clone, so seeding is appropriate. (Plain attach/restart never reseeds.)
async function finalizeAndAttach(p: TaskParams, noAttach: boolean): Promise<never> {
  if (!(await waitForSession(p.containerName))) {
    warn("tmux session did not appear after 60s; the clone may have failed.");
    warn(`Investigate with: cww shell ${p.workspaceName}`);
    process.exit(1);
  }
  // A failed clone leaves nothing to seed — report it and open the failure log
  // (the session shows 'less /workspace/cww.log'; q lands in a shell there).
  if (await setupFailed(p.containerName)) {
    error("Repo setup failed inside the workspace; details in /workspace/cww.log.");
    if (noAttach) {
      info(`Read it with: cww attach ${p.workspaceName} (opens the log; q for a shell)`);
      process.exit(1);
    }
    info("Attaching to the failure log (q for a shell; Ctrl-a d to detach)...");
    console.log("");
    await attachAgentSession(p.containerName);
    process.exit(1); // unreachable — attachAgentSession exits
  }
  // Personal skills/commands/agents and the seed script are best-effort — a
  // failure here must not take down an otherwise-good workspace.
  try {
    await materializeCwwAssets(p.projectPath, p.containerName, p.agent);
  } catch {
    // ignore
  }
  try {
    await runResetScript(p.projectPath, p.containerName);
  } catch {
    // ignore — same '|| true' the bash script applied
  }

  if (noAttach) {
    success("Workspace ready.");
    info(`Use 'cww attach ${p.workspaceName}' to connect, 'cww shell ${p.workspaceName}' for a shell.`);
    process.exit(0);
  }
  info(`Attaching to the agent session (${agentLabel(p.agent)})...`);
  info(`Press Ctrl-a d to detach, 'cww attach ${p.workspaceName}' to reattach`);
  console.log("");
  await attachAgentSession(p.containerName);
  process.exit(0); // unreachable — attachAgentSession exits
}

// --- Command -------------------------------------------------------------------

export async function runCreate(argv: string[]): Promise<void> {
  // Hand-rolled parsing: the positionals are order/type-sensitive
  // ([project-path] <workspace-name>) and --branch/--ref alias each other.
  let projectArg = "";
  let workspaceName = "";
  let branchName = "";
  let agentArg = "";
  let remoteArg = "";
  let noAttach = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--branch":
      case "--ref":
        branchName = argv[++i] ?? "";
        break;
      case "--agent":
        agentArg = argv[++i] ?? "";
        validateAgent(agentArg);
        break;
      case "--remote":
        remoteArg = argv[++i] ?? "";
        break;
      case "--no-attach":
        noAttach = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        return;
      default:
        if (arg.startsWith("-")) die(`Unknown option: ${arg}`);
        // Positional arguments: [project-path] <workspace-name>
        if (!workspaceName && !projectArg) {
          // First positional: a path (dir / "." / absolute) is the project;
          // anything else is the workspace name.
          if (arg === "." || arg.startsWith("/") || fs.existsSync(arg)) {
            projectArg = arg;
          } else {
            workspaceName = arg;
          }
        } else if (!workspaceName) {
          workspaceName = arg;
        } else {
          die(`Unexpected argument: ${arg}`);
        }
    }
  }

  if (!workspaceName) {
    error("Workspace name is required");
    console.log(USAGE);
    process.exit(1);
  }

  // Resolve project path (defaults to the current directory).
  let projectPath = resolveProjectPath(projectArg || undefined);
  let projectName = path.basename(projectPath);

  if (!(await isGitRepo(projectPath))) {
    die(`Not a git repository: ${projectPath}`);
  }

  // Get the actual git root (in case we're in a subdirectory).
  const gitRoot = await getGitRoot(projectPath);
  if (gitRoot && gitRoot !== projectPath) {
    info(`Using git root: ${gitRoot}`);
    projectPath = gitRoot;
    projectName = path.basename(projectPath);
  }

  // Default the branch to check out to whatever the host is on. Empty (e.g.
  // detached HEAD) is fine: the container simply stays on the clone's default.
  if (!branchName) {
    branchName = await getCurrentBranch(projectPath);
  }

  // Global env only (agent auth tokens, CWW_AGENT/CWW_BROWSER defaults);
  // per-project settings live in ~/.cww/config.json.
  loadEnvFile(path.join(os.homedir(), ".cww", "env"));

  // Per-project config. No entry means this repo was never set up — the
  // first create IS the setup: capture the clone URL and a credential
  // validated with 'git ls-remote', then continue into creation. The URL
  // setup returns is used AS IS — the user may have corrected the derived
  // one (scheme/port), and re-deriving below would discard that.
  // Non-interactive callers get a hard error instead of a hung prompt.
  let cfg = getProjectConfig(projectPath);
  let repoUrl = "";
  if (!cfg) {
    if (!process.stdin.isTTY) {
      die(`Repo not set up for cww and no TTY to ask — run 'cww init' in ${projectPath} first.`);
    }
    info("First workspace for this repo — running setup (once per repo).");
    repoUrl = await setupRepo(projectPath, { remote: remoteArg || undefined });
    cfg = getProjectConfig(projectPath);
  }
  // The project's browser and skill overrides ride the same env channel as
  // the global defaults: browserEnabled()/skillEnabled() and the
  // {{CWW_BROWSER}} template var all read process.env.
  if (cfg?.browser) process.env.CWW_BROWSER = cfg.browser;
  if (cfg?.skill) process.env.CWW_SKILL = cfg.skill;

  // Which agent this workspace runs. Precedence: --agent > the project's
  // agent (~/.cww/config.json) > CWW_AGENT (global env) > claude. A workspace
  // whose metadata already exists keeps its recorded agent instead (see
  // below).
  let agent = resolveAgent(agentArg || cfg?.agent || undefined);

  // The repo URL to clone inside the container (unless setup just captured
  // it above). --remote naming the SAME remote the config entry was set up
  // for uses the configured URL — it may carry the user's corrections
  // (scheme/port) that a re-derivation would discard; a different remote is
  // per-invocation intent (e.g. fork vs upstream) and is derived fresh.
  // Otherwise the URL captured at setup applies; the origin fallback only
  // fires for a hand-written config entry lacking repoUrl.
  if (!repoUrl && remoteArg && (remoteArg !== cfg?.remote || !cfg?.repoUrl)) {
    const remote = await $`git -C ${projectPath} remote get-url ${remoteArg}`.quiet().nothrow();
    if (remote.exitCode !== 0) {
      die(`Remote '${remoteArg}' not found in ${projectPath}. Run 'git remote -v' to list remotes.`);
    }
    repoUrl = normalizeGitUrl(remote.text().trim());
  }
  if (!repoUrl) repoUrl = cfg?.repoUrl ?? "";
  if (!repoUrl) {
    const origin = await $`git -C ${projectPath} remote get-url origin`.quiet().nothrow();
    if (origin.exitCode === 0) repoUrl = normalizeGitUrl(origin.text().trim());
  }
  if (!repoUrl) {
    die(
      `No clone URL: the repo has no 'origin' remote and no repoUrl in ~/.cww/config.json. Add a remote (or pick one with --remote), or re-run 'cww init'.`,
    );
  }

  // The developer's identity for authorship inside the container.
  const nameR = await $`git -C ${projectPath} config user.name`.quiet().nothrow();
  const emailR = await $`git -C ${projectPath} config user.email`.quiet().nothrow();
  const gitAuthorName = nameR.exitCode === 0 ? nameR.text().trim() : "";
  const gitAuthorEmail = emailR.exitCode === 0 ? emailR.text().trim() : "";
  if (!gitAuthorName || !gitAuthorEmail) {
    error("git identity not configured; the container needs it to author commits.");
    console.error("  Set it once per machine, then re-run 'cww create':");
    console.error('    git config --global user.name  "Your Name"');
    console.error('    git config --global user.email "you@example.com"');
    process.exit(1);
  }

  // Paths and names (keyed on the workspace name, not the branch).
  const taskDir = getTaskDir(projectName, workspaceName);
  const containerName = getContainerName(projectName, workspaceName);

  // A workspace that already has metadata keeps its original agent: the
  // recorded value beats flags/defaults so a recreate brings back the same
  // workspace. (Sessions from before agents were recorded default to claude.)
  const taskDirExists = fs.existsSync(taskDir);
  if (taskDirExists) {
    const recorded = (readSession(taskDir).agent as Agent | undefined) || "claude";
    if (agentArg && agentArg !== recorded) {
      warn(`Workspace '${workspaceName}' was created with agent '${recorded}'; ignoring --agent ${agentArg}.`);
      warn("To switch agents, teardown the workspace and create it again.");
    }
    agent = recorded;
  }

  const params: TaskParams = {
    taskDir,
    containerName,
    workspaceName,
    branchName,
    agent,
    repoUrl,
    gitAuthorName,
    gitAuthorEmail,
    projectPath,
  };

  info(`Project: ${projectName}`);
  info(`Workspace: ${workspaceName}`);
  info(`Branch: ${branchName || "<repo default>"}`);
  info(`Agent: ${agentLabel(agent)}`);
  info(`Repo: ${repoUrl}`);
  info(`Container: ${containerName}`);

  // Already running / stopped-but-present: attach-only paths.
  if (await containerRunning(containerName)) {
    warn(`Workspace '${workspaceName}' is already running.`);
    if (confirm("Attach to it?")) {
      await attachAgentSession(containerName);
    }
    return;
  }

  if (await containerExists(containerName)) {
    warn(`Workspace '${workspaceName}' exists but is stopped.`);
    if (confirm("Start and attach to it?")) {
      // The whole stack, not just the agent container — same as attach/shell;
      // a workspace without its services (DB, ...) is of limited use.
      await startTaskStack(taskDir, containerName);
      // Existing workspace with preserved state — attach, don't reseed.
      info("Attaching to the agent session...");
      await attachAgentSession(containerName);
    }
    return;
  }

  // From here on a container gets (re)created, so the agent's auth and image
  // must be in place. The attach-only paths above need neither. The
  // containerEnv hook runs here too — it can die() on invalid user config
  // (e.g. a broken .cww/opencode.json), and that must happen before any
  // metadata or container is created.
  agentPreflight(agent, projectPath);
  const agentEnv = agentContainerEnv(agent, projectPath);
  await ensureAgentImage(agent);

  const projectServices = path.join(projectPath, ".cww", "docker-compose.services.yml");
  const taskServices = path.join(taskDir, "docker-compose.services.yml");

  // Task metadata exists but no container (e.g. it was removed): recreate it
  // from the saved compose files. The clone is gone with the container, so the
  // entrypoint re-clones fresh — a clean workspace, so finalize (seed) applies.
  if (taskDirExists) {
    warn(`Workspace metadata exists at ${taskDir} but no container is present.`);
    info("Recreating the workspace...");
    writeTaskEnv(taskDir, repoUrl);
    generateCompose(params);
    generateHostsOverride(taskDir, projectPath);
    generateBrowserOverride(taskDir);
    generateAgentEnvOverride(taskDir, agentEnv);
    await composeUp(taskDir);
    await finalizeAndAttach(params, noAttach);
  }

  // Write session metadata.
  writeSession(taskDir, {
    project: projectName,
    workspace: workspaceName,
    branch: branchName,
    agent,
    container: containerName,
    taskDir,
    mainRepo: projectPath,
    repoUrl,
    created: new Date().toISOString(),
  });

  writeTaskEnv(taskDir, repoUrl);

  info("Generating docker-compose configuration...");
  generateCompose(params);

  // Project-specific services ride along into the task dir.
  if (fs.existsSync(projectServices)) {
    info("Found project-specific services configuration");
    fs.copyFileSync(projectServices, taskServices);
    // Ensure any declared ~/.cww/cache mount exists and is container-writable.
    await provisionDeclaredCaches(taskServices);
  }

  info("Starting workspace (the container clones the repo inside)...");
  generateHostsOverride(taskDir, projectPath);
  generateBrowserOverride(taskDir);
  generateAgentEnvOverride(taskDir, agentEnv);
  await composeUp(taskDir);

  success("Container started successfully!");
  console.log("");
  console.log(`Workspace: ${workspaceName}`);
  console.log(`Container: ${containerName}`);
  console.log("");

  suggestCaches(projectPath, taskServices);

  await finalizeAndAttach(params, noAttach);
}
