import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentBuildPlan,
  agentContainerEnv,
  agentImage,
  agentLabel,
  CWW_AGENTS,
  getCwwDir,
  personalAssetPlan,
  resolveAgent,
  validateAgent,
} from "../src/agents/registry";
import { opencodeAgent, opencodeContainerEnv, resolveOpencodeConfigFile } from "../src/agents/opencode/agent";
import { PERSONAL_ASSET_KINDS } from "../src/agents/types";

describe("CWW_AGENTS", () => {
  test("lists the registered agents in registration order", () => {
    expect([...CWW_AGENTS]).toEqual(["claude", "vibe", "opencode"]);
  });
});

describe("validateAgent", () => {
  test("accepts every registered agent", () => {
    for (const agent of CWW_AGENTS) {
      expect(() => validateAgent(agent)).not.toThrow();
    }
  });

  test("exits for unknown agents", () => {
    // validateAgent dies via process.exit, so probe it in a subprocess.
    const registry = path.join(import.meta.dir, "..", "src", "agents", "registry.ts");
    const r = Bun.spawnSync({
      cmd: ["bun", "-e", `const { validateAgent } = await import(${JSON.stringify(registry)}); validateAgent("nope")`],
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(new TextDecoder().decode(r.stderr)).toContain("Unknown agent 'nope'");
  });
});

describe("resolveAgent", () => {
  test("an explicit request beats CWW_AGENT", () => {
    expect(resolveAgent("vibe", { CWW_AGENT: "claude" })).toBe("vibe");
  });

  test("CWW_AGENT beats the default", () => {
    expect(resolveAgent(undefined, { CWW_AGENT: "vibe" })).toBe("vibe");
  });

  test("defaults to claude", () => {
    expect(resolveAgent(undefined, {})).toBe("claude");
  });
});

describe("agentLabel / agentImage", () => {
  test("labels come from the agent definitions", () => {
    expect(agentLabel("claude")).toBe("Claude Code");
    expect(agentLabel("vibe")).toBe("Mistral Vibe");
    expect(agentLabel("opencode")).toBe("OpenCode");
  });

  test("an unknown agent falls back to its own name", () => {
    expect(agentLabel("mystery")).toBe("mystery");
  });

  test("each agent gets its own image tag", () => {
    expect(agentImage("claude")).toBe("coder-workspace-workflow:claude");
    expect(agentImage("vibe")).toBe("coder-workspace-workflow:vibe");
    expect(agentImage("opencode")).toBe("coder-workspace-workflow:opencode");
  });
});

describe("personalAssetPlan", () => {
  // A throwaway project dir carrying the given .cww/<kind> subfolders.
  function projectWith(...kinds: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    for (const kind of kinds) {
      fs.mkdirSync(path.join(dir, ".cww", kind), { recursive: true });
    }
    return dir;
  }

  test("claude consumes the whole triad", () => {
    const dir = projectWith("skills", "commands", "agents");
    expect(personalAssetPlan(dir, "claude")).toEqual({
      copies: [
        { kind: "skills", src: path.join(dir, ".cww", "skills"), dest: "/home/developer/.claude/skills" },
        { kind: "commands", src: path.join(dir, ".cww", "commands"), dest: "/home/developer/.claude/commands" },
        { kind: "agents", src: path.join(dir, ".cww", "agents"), dest: "/home/developer/.claude/agents" },
      ],
      skipped: [],
    });
  });

  test("vibe takes skills (portable format) and skips the Claude-only kinds", () => {
    const dir = projectWith("skills", "commands", "agents");
    expect(personalAssetPlan(dir, "vibe")).toEqual({
      copies: [{ kind: "skills", src: path.join(dir, ".cww", "skills"), dest: "/home/developer/.vibe/skills" }],
      skipped: ["commands", "agents"],
    });
  });

  test("opencode takes skills (portable format) and skips the Claude-only kinds", () => {
    const dir = projectWith("skills", "commands", "agents");
    expect(personalAssetPlan(dir, "opencode")).toEqual({
      copies: [{ kind: "skills", src: path.join(dir, ".cww", "skills"), dest: "/home/developer/.config/opencode/skills" }],
      skipped: ["commands", "agents"],
    });
  });

  test("a skills-only project skips nothing for vibe", () => {
    const dir = projectWith("skills");
    const plan = personalAssetPlan(dir, "vibe");
    expect(plan.copies.map((c) => c.kind)).toEqual(["skills"]);
    expect(plan.skipped).toEqual([]);
  });

  test("no .cww/ means an empty plan for every agent", () => {
    const dir = projectWith();
    for (const agent of CWW_AGENTS) {
      expect(personalAssetPlan(dir, agent)).toEqual({ copies: [], skipped: [] });
    }
  });

  test("every mapped destination is an absolute path in the container home", () => {
    const dir = projectWith(...PERSONAL_ASSET_KINDS);
    for (const agent of CWW_AGENTS) {
      for (const { dest } of personalAssetPlan(dir, agent).copies) {
        expect(dest).toStartWith("/home/developer/");
      }
    }
  });
});

describe("opencode config file", () => {
  // Throwaway project and home dirs, optionally carrying a .cww/opencode.json.
  function dirWithConfig(config?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    if (config !== undefined) {
      fs.mkdirSync(path.join(dir, ".cww"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".cww", "opencode.json"), config);
    }
    return dir;
  }

  const CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": { "llama.cpp": { "options": { "baseURL": "http://llamahost:8080/v1" } } },
  "model": "llama.cpp/local"
}`;

  test("the project file beats the global one", () => {
    const project = dirWithConfig(CONFIG);
    const home = dirWithConfig(CONFIG);
    expect(resolveOpencodeConfigFile(project, home)).toBe(
      path.join(project, ".cww", "opencode.json"),
    );
  });

  test("falls back to the global file, then to none", () => {
    const project = dirWithConfig();
    const home = dirWithConfig(CONFIG);
    expect(resolveOpencodeConfigFile(project, home)).toBe(path.join(home, ".cww", "opencode.json"));
    expect(resolveOpencodeConfigFile(project, dirWithConfig())).toBeNull();
  });

  test("containerEnv delivers the file as minified valid JSON", () => {
    const project = dirWithConfig(CONFIG);
    const env = opencodeContainerEnv(project, {}, dirWithConfig());
    expect(Object.keys(env)).toEqual(["OPENCODE_CONFIG_CONTENT"]);
    const value = env.OPENCODE_CONFIG_CONTENT!;
    expect(value).not.toContain("\n");
    expect(JSON.parse(value)).toEqual(JSON.parse(CONFIG));
  });

  test("no config file means no injected env", () => {
    expect(opencodeContainerEnv(dirWithConfig(), {}, dirWithConfig())).toEqual({});
  });

  test("warns when a hand-set OPENCODE_CONFIG_CONTENT would be overridden by the file", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      opencodeContainerEnv(dirWithConfig(CONFIG), { OPENCODE_CONFIG_CONTENT: "{}" }, dirWithConfig());
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("the file wins");
    } finally {
      log.mockRestore();
    }
  });

  test("invalid JSON dies loudly, naming the file", () => {
    // die() exits the process, so probe in a subprocess (like validateAgent).
    const project = dirWithConfig('{"provider": '); // missing brace
    const home = dirWithConfig();
    const agentMod = path.join(import.meta.dir, "..", "src", "agents", "opencode", "agent.ts");
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `const { opencodeContainerEnv } = await import(${JSON.stringify(agentMod)}); opencodeContainerEnv(${JSON.stringify(project)}, {}, ${JSON.stringify(home)})`,
      ],
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(r.stderr);
    expect(stderr).toContain("Invalid JSON");
    expect(stderr).toContain(path.join(project, ".cww", "opencode.json"));
  });

  test("the registry dispatch reaches the opencode hook, and other agents contribute nothing", () => {
    const project = dirWithConfig(CONFIG);
    const env = agentContainerEnv("opencode", project, {});
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(JSON.parse(CONFIG));
    expect(agentContainerEnv("claude", project, {})).toEqual({});
    expect(agentContainerEnv("vibe", project, {})).toEqual({});
  });

  test("preflight accepts the config file as keyless auth (warn-and-continue)", () => {
    const project = dirWithConfig(CONFIG);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // Would process.exit(1) without an accepter; returning means accepted.
      expect(opencodeAgent.preflight(project, {})).toBeUndefined();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(path.join(project, ".cww", "opencode.json"));
    } finally {
      log.mockRestore();
    }
  });
});

describe("agentBuildPlan", () => {
  test("builds the shared base first, then the agent's own folder", () => {
    expect(agentBuildPlan("vibe")).toEqual([
      { tag: "cww-base:latest", context: path.join("docker", "base") },
      { tag: "coder-workspace-workflow:vibe", context: path.join("src", "agents", "vibe") },
    ]);
  });

  test("every step's build context exists and carries a Dockerfile", () => {
    for (const agent of CWW_AGENTS) {
      for (const step of agentBuildPlan(agent)) {
        expect(fs.existsSync(path.join(getCwwDir(), step.context, "Dockerfile"))).toBe(true);
      }
    }
  });
});
