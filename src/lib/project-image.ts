// Per-project workspace image: a repo can carry a .cww/Dockerfile that cww
// builds ON TOP of the chosen agent's image at container-(re)creation time.
// The agent images themselves stay fixed (coder-workspace-workflow:<id>);
// the project layer is a separate stacked image, opted into purely by the
// file's presence — like every other .cww/ hook, it is read from the host
// checkout, so edits apply to the next create.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";
import { agentImage, agentLabel, ensureAgentImage, type Agent } from "../agents/registry";
import { imageAgeHours, imageIsStale, inspectImages } from "./docker";
import { sanitizeName } from "./naming";
import { die, info, success, warn } from "./ui";

export interface ProjectImagePlan {
  tag: string; // cww-project-<name>:<agent>
  context: string; // <projectPath>/.cww — so COPY sees files next to the Dockerfile
  dockerfile: string; // <projectPath>/.cww/Dockerfile
  baseImage: string; // coder-workspace-workflow:<agent>, passed as BASE_IMAGE
}

// The project layer to build, or null when the repo carries no
// .cww/Dockerfile. Pure data aside from the existence check, so tests cover
// tags/paths without Docker (same philosophy as agentBuildPlan). The tag is
// keyed by project basename — two repos sharing a basename share a tag, the
// same collision already accepted for task dirs and container names.
export function projectImagePlan(
  projectPath: string,
  projectName: string,
  agent: Agent,
): ProjectImagePlan | null {
  const dockerfile = path.join(projectPath, ".cww", "Dockerfile");
  if (!fs.existsSync(dockerfile)) return null;
  return {
    tag: `cww-project-${sanitizeName(projectName)}:${agent}`,
    context: path.join(projectPath, ".cww"),
    dockerfile,
    baseImage: agentImage(agent),
  };
}

// Whether the Dockerfile consumes the BASE_IMAGE build-arg. A file that
// hardcodes its FROM instead silently pins one agent — or worse, builds on an
// image without the cww entrypoint, tmux session, and developer user.
export function usesBaseImageArg(dockerfileText: string): boolean {
  return dockerfileText.includes("BASE_IMAGE");
}

// The create-time age hint. A container keeps its create-time image for life,
// so creating from an old agent image freezes an old CLI into the workspace
// for as long as it exists — and the only moment that is cheap to fix is
// before the container exists. Advisory, never blocking: it says what to type
// and that acting means starting over, and leaves the choice alone. Pure, so
// the wording and the threshold are covered without Docker; null means there
// is nothing worth saying.
export function staleAgentImageNotice(agent: Agent, ageHours: number | null): string | null {
  if (!imageIsStale(ageHours)) return null;
  return (
    `${agentImage(agent)} was built ${Math.floor(ageHours! / 24)}d ago — the ${agentLabel(agent)} CLI in it is that old. ` +
    `Ctrl-C and run 'cww build ${agent}' to create this workspace from the current release.`
  );
}

// The image a new workspace container runs: the agent image, with the
// project's optional .cww/Dockerfile layered on top. The agent image is
// ensured first (it is the FROM), and the project layer is always rebuilt —
// no freshness tracking: Docker's layer cache makes a no-op rebuild take
// seconds and correctly detects Dockerfile AND COPY-source changes (same
// philosophy as agentBuildPlan's unconditional base rebuild).
export async function resolveWorkspaceImage(
  projectPath: string,
  projectName: string,
  agent: Agent,
): Promise<string> {
  await ensureAgentImage(agent);
  // Against the AGENT image, even when a project layer is stacked on top: the
  // project layer is rebuilt on every create, so its own age says nothing
  // about the CLI, which lives underneath.
  const base = agentImage(agent);
  const notice = staleAgentImageNotice(
    agent,
    imageAgeHours((await inspectImages([base])).get(base)?.created),
  );
  if (notice) warn(notice);

  const plan = projectImagePlan(projectPath, projectName, agent);
  if (!plan) return agentImage(agent);
  if (!usesBaseImageArg(fs.readFileSync(plan.dockerfile, "utf8"))) {
    warn(
      ".cww/Dockerfile doesn't use ARG BASE_IMAGE — start it with 'ARG BASE_IMAGE' + 'FROM ${BASE_IMAGE}' so it stacks on the workspace's agent image.",
    );
  }
  info(`Building project image ${plan.tag} (.cww/Dockerfile on ${plan.baseImage}) ...`);
  // Streams docker's own progress/errors, like buildAgentImage.
  const r =
    await $`docker build -t ${plan.tag} --build-arg BASE_IMAGE=${plan.baseImage} -f ${plan.dockerfile} ${plan.context}`.nothrow();
  if (r.exitCode !== 0) {
    die(
      `Project image build failed (.cww/Dockerfile). Fix the Dockerfile, or remove it to run on the plain agent image (${plan.baseImage}).`,
    );
  }
  success(`Project image built: ${plan.tag}`);
  return plan.tag;
}
