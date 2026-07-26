import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CWW_AGENTS } from "../src/agents/registry";
import { STALE_IMAGE_DAYS } from "../src/lib/docker";
import { projectImagePlan, staleAgentImageNotice, usesBaseImageArg } from "../src/lib/project-image";

// A throwaway project dir, optionally carrying a .cww/Dockerfile.
function projectWith(dockerfile?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  if (dockerfile !== undefined) {
    fs.mkdirSync(path.join(dir, ".cww"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cww", "Dockerfile"), dockerfile);
  }
  return dir;
}

const DOCKERFILE = "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nRUN true\n";

describe("projectImagePlan", () => {
  test("no .cww/Dockerfile means no project layer", () => {
    const dir = projectWith();
    for (const agent of CWW_AGENTS) {
      expect(projectImagePlan(dir, "myapp", agent)).toBeNull();
    }
  });

  test("a Dockerfile yields the stacked-image plan", () => {
    const dir = projectWith(DOCKERFILE);
    expect(projectImagePlan(dir, "myapp", "claude")).toEqual({
      tag: "cww-project-myapp:claude",
      context: path.join(dir, ".cww"),
      dockerfile: path.join(dir, ".cww", "Dockerfile"),
      baseImage: "coder-workspace-workflow:claude",
    });
  });

  test("the tag is keyed by agent, so switching agents never reuses a stale stack", () => {
    const dir = projectWith(DOCKERFILE);
    for (const agent of CWW_AGENTS) {
      const plan = projectImagePlan(dir, "myapp", agent)!;
      expect(plan.tag).toBe(`cww-project-myapp:${agent}`);
      expect(plan.baseImage).toBe(`coder-workspace-workflow:${agent}`);
    }
  });

  test("the project name is sanitized like container/task names", () => {
    const dir = projectWith(DOCKERFILE);
    expect(projectImagePlan(dir, "My App", "claude")?.tag).toBe("cww-project-my-app:claude");
  });
});

describe("staleAgentImageNotice", () => {
  const STALE = STALE_IMAGE_DAYS * 24;

  test("says nothing below the threshold, or when the age is unknown", () => {
    expect(staleAgentImageNotice("claude", STALE - 1)).toBeNull();
    expect(staleAgentImageNotice("claude", 0)).toBeNull();
    expect(staleAgentImageNotice("claude", null)).toBeNull();
  });

  test("names the image, the agent, the age, and the command that fixes it", () => {
    const notice = staleAgentImageNotice("opencode", 45 * 24)!;
    expect(notice).toContain("coder-workspace-workflow:opencode");
    expect(notice).toContain("45d");
    expect(notice).toContain("cww build opencode");
    // Acting on it means not creating this workspace yet — say so.
    expect(notice).toContain("Ctrl-C");
  });

  test("fires for every agent, and shares 'cww list''s threshold", () => {
    for (const agent of CWW_AGENTS) {
      expect(staleAgentImageNotice(agent, STALE)).toContain(`cww build ${agent}`);
    }
  });
});

describe("usesBaseImageArg", () => {
  test("accepts the documented ARG BASE_IMAGE convention", () => {
    expect(usesBaseImageArg(DOCKERFILE)).toBe(true);
    expect(usesBaseImageArg("ARG BASE_IMAGE=coder-workspace-workflow:claude\nFROM ${BASE_IMAGE}\n")).toBe(true);
  });

  test("flags a hardcoded FROM", () => {
    expect(usesBaseImageArg("FROM coder-workspace-workflow:claude\nRUN true\n")).toBe(false);
    expect(usesBaseImageArg("FROM ubuntu:24.04\n")).toBe(false);
  });
});
