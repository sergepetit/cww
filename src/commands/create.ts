// cww create — create a workspace: a container that clones the repo and runs
// the app's services. The workspace is identified by a NAME you choose; git
// inside it (branches, rebases, pushes) is entirely yours — cww dictates none.

import { $ } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentLabel,
  agentPreflight,
  agentImage,
  ensureAgentImage,
  getCwwDir,
  resolveAgent,
  validateAgent,
  type Agent,
} from "../lib/agents";
import { browserEnabled } from "../lib/config";
import {
  attachAgentSession,
  containerExists,
  containerRunning,
  materializeCwwAssets,
  provisionCacheDir,
  runResetScript,
  startTaskStack,
  taskCompose,
} from "../lib/docker";
import { loadEnvFile } from "../lib/env";
import { getCurrentBranch, getGitRoot, isGitRepo } from "../lib/git";
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

Options:
  --branch <ref>    Branch to check out inside the workspace
                    (default: the branch you're currently on; a name that
                    doesn't exist upstream is created fresh)
  --ref <ref>       Alias for --branch
  --agent <name>    Coding agent to run in the workspace: claude | vibe
                    (default: CWW_AGENT from ~/.cww/env or <repo>/.cww/env,
                    falling back to claude)
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

// Extra-hosts entries from a user-maintained hosts file: each non-comment line
// is "hostname ip"; anything else is skipped.
export function parseHostsEntries(text: string): Array<{ host: string; ip: string }> {
  const out: Array<{ host: string; ip: string }> = [];
  for (const line of text.split("\n")) {
    const [host, ip] = line.trim().split(/\s+/);
    if (!host || host.startsWith("#") || !ip) continue;
    out.push({ host, ip });
  }
  return out;
}

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
  const entries: Array<{ host: string; ip: string }> = [];
  for (const f of [
    path.join(os.homedir(), ".cww", "hosts"),
    path.join(projectPath, ".cww", "hosts"),
  ]) {
    if (!fs.existsSync(f)) continue;
    entries.push(...parseHostsEntries(fs.readFileSync(f, "utf8")));
  }
  if (entries.length > 0) {
    const lines = entries.map((e) => `      - "${e.host}:${e.ip}"`);
    fs.writeFileSync(out, `services:\n  coder:\n    extra_hosts:\n${lines.join("\n")}\n`);
    info(`Adding ${entries.length} extra host(s) to the container`);
  } else {
    fs.rmSync(out, { force: true });
  }
}

// Render the override publishing the built-in browser's noVNC port (default
// on; CWW_BROWSER=off in ~/.cww/env or <repo>/.cww/env skips it, and the
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

  // Env is layered: the global ~/.cww/env (tokens, Claude auth) first, then
  // the per-project <repo>/.cww/env if present, so it can override CWW_REPO_URL
  // for THIS repo. A global CWW_REPO_URL would otherwise pin every project to
  // one clone URL — the per-project file is how each repo carries its own.
  loadEnvFile(path.join(os.homedir(), ".cww", "env"));
  const projectEnvFile = path.join(projectPath, ".cww", "env");
  if (fs.existsSync(projectEnvFile)) {
    info(`Loading per-project env: ${projectEnvFile}`);
    loadEnvFile(projectEnvFile);
  }

  // Which agent this workspace runs. Precedence: --agent > CWW_AGENT (global
  // or per-project env, loaded above) > claude. A workspace whose metadata
  // already exists keeps its recorded agent instead (see below).
  let agent = resolveAgent(agentArg || undefined);

  // The repo URL to clone inside the container. CWW_REPO_URL (optional)
  // overrides it verbatim and skips normalization — needed when origin is an
  // SSH remote whose web endpoint can't be inferred, e.g. a self-hosted
  // Forgejo/Gitea on plain http or a non-443 port.
  let repoUrl = process.env.CWW_REPO_URL ?? "";
  if (!repoUrl) {
    const origin = await $`git -C ${projectPath} remote get-url origin`.quiet().nothrow();
    if (origin.exitCode === 0) repoUrl = normalizeGitUrl(origin.text().trim());
  }
  if (!repoUrl) {
    die(
      `Repository has no 'origin' remote and CWW_REPO_URL is unset. cww clones origin inside the container; add a remote or set CWW_REPO_URL in ${projectPath}/.cww/env (per-project) or ~/.cww/env (global).`,
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
  // must be in place. The attach-only paths above need neither.
  agentPreflight(agent, projectPath);
  await ensureAgentImage(agent);

  const projectServices = path.join(projectPath, ".cww", "docker-compose.services.yml");
  const taskServices = path.join(taskDir, "docker-compose.services.yml");

  // Task metadata exists but no container (e.g. it was removed): recreate it
  // from the saved compose files. The clone is gone with the container, so the
  // entrypoint re-clones fresh — a clean workspace, so finalize (seed) applies.
  if (taskDirExists) {
    warn(`Workspace metadata exists at ${taskDir} but no container is present.`);
    info("Recreating the workspace...");
    generateCompose(params);
    generateHostsOverride(taskDir, projectPath);
    generateBrowserOverride(taskDir);
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
  await composeUp(taskDir);

  success("Container started successfully!");
  console.log("");
  console.log(`Workspace: ${workspaceName}`);
  console.log(`Container: ${containerName}`);
  console.log("");

  suggestCaches(projectPath, taskServices);

  await finalizeAndAttach(params, noAttach);
}
