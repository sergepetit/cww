import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentAuthEnvKeys,
  agentAuthMethods,
  agentConfigFile,
  AGENT_VERSION_FILE,
  agentBuildPlan,
  agentContainerEnv,
  agentImage,
  agentLabel,
  allAuthEnvKeys,
  BUILTIN_SKILL_REFERENCES,
  builtinSkillPlan,
  CWW_AGENTS,
  findAuthMethod,
  getCwwDir,
  parseAgentVersion,
  personalAssetPlan,
  resolveAgent,
  skillRefreshPlan,
  validateAgent,
} from "../src/agents/registry";
import { claudeContainerEnv } from "../src/agents/claude/agent";
import { copilotAgent, copilotContainerEnv } from "../src/agents/copilot/agent";
import { opencodeAgent, opencodeContainerEnv, resolveOpencodeConfigFile } from "../src/agents/opencode/agent";
import { piAgent, resolvePiConfigFile } from "../src/agents/pi/agent";
import { PERSONAL_ASSET_KINDS } from "../src/agents/types";

describe("CWW_AGENTS", () => {
  test("lists the registered agents in registration order", () => {
    expect([...CWW_AGENTS]).toEqual(["claude", "vibe", "opencode", "copilot", "pi"]);
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
    expect(agentLabel("copilot")).toBe("GitHub Copilot");
    expect(agentLabel("pi")).toBe("Pi");
  });

  test("an unknown agent falls back to its own name", () => {
    expect(agentLabel("mystery")).toBe("mystery");
  });

  test("each agent gets its own image tag", () => {
    expect(agentImage("claude")).toBe("coder-workspace-workflow:claude");
    expect(agentImage("vibe")).toBe("coder-workspace-workflow:vibe");
    expect(agentImage("opencode")).toBe("coder-workspace-workflow:opencode");
    expect(agentImage("copilot")).toBe("coder-workspace-workflow:copilot");
    expect(agentImage("pi")).toBe("coder-workspace-workflow:pi");
  });
});

describe("authMethods", () => {
  test("every agent declares at least one method, with unique ids and valid keys", () => {
    for (const agent of CWW_AGENTS) {
      const methods = agentAuthMethods(agent);
      expect(methods.length).toBeGreaterThan(0);
      expect(new Set(methods.map((m) => m.id)).size).toBe(methods.length);
      for (const m of methods) {
        if (m.envKey !== undefined) expect(m.envKey).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
    }
  });

  test("the first method (the default) always carries an env key", () => {
    // The resolution auto-picks the default only when its key is stored; a
    // keyless default would silently pick itself.
    for (const agent of CWW_AGENTS) {
      expect(agentAuthMethods(agent)[0]?.envKey).toBeTruthy();
    }
  });

  test("the known methods are declared where expected", () => {
    expect(agentAuthMethods("claude").map((m) => [m.id, m.envKey])).toEqual([
      ["oauth-token", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["api-key", "ANTHROPIC_API_KEY"],
      ["none", undefined],
    ]);
    expect(agentAuthMethods("vibe").map((m) => [m.id, m.envKey])).toEqual([
      ["api-key", "MISTRAL_API_KEY"],
      ["config-file", undefined],
    ]);
    expect(agentAuthMethods("opencode").map((m) => [m.id, m.envKey])).toEqual([
      ["anthropic-api-key", "ANTHROPIC_API_KEY"],
      ["openai-api-key", "OPENAI_API_KEY"],
      ["openrouter-api-key", "OPENROUTER_API_KEY"],
      ["opencode-api-key", "OPENCODE_API_KEY"],
      ["config-file", undefined],
    ]);
    expect(agentAuthMethods("copilot").map((m) => [m.id, m.envKey])).toEqual([
      ["github-token", "COPILOT_GITHUB_TOKEN"],
      ["provider", undefined],
      ["provider-key", "COPILOT_PROVIDER_API_KEY"],
    ]);
    expect(agentAuthMethods("pi").map((m) => [m.id, m.envKey])).toEqual([
      ["anthropic-api-key", "ANTHROPIC_API_KEY"],
      ["openai-api-key", "OPENAI_API_KEY"],
      ["openrouter-api-key", "OPENROUTER_API_KEY"],
      ["config-file", undefined],
    ]);
  });

  test("agentAuthEnvKeys drops keyless methods", () => {
    expect(agentAuthEnvKeys("claude")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(agentAuthEnvKeys("vibe")).toEqual(["MISTRAL_API_KEY"]);
  });

  test("findAuthMethod resolves by id, null on unknown", () => {
    expect(findAuthMethod("claude", "api-key")?.envKey).toBe("ANTHROPIC_API_KEY");
    expect(findAuthMethod("claude", "nope")).toBeNull();
  });

  test("allAuthEnvKeys is the deduplicated union across agents", () => {
    const keys = allAuthEnvKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "MISTRAL_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENCODE_API_KEY",
        "COPILOT_GITHUB_TOKEN",
        "COPILOT_PROVIDER_API_KEY",
      ].sort(),
    );
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

  test("copilot takes skills (portable format) and skips the Claude-only kinds", () => {
    const dir = projectWith("skills", "commands", "agents");
    expect(personalAssetPlan(dir, "copilot")).toEqual({
      copies: [{ kind: "skills", src: path.join(dir, ".cww", "skills"), dest: "/home/developer/.copilot/skills" }],
      skipped: ["commands", "agents"],
    });
  });

  test("pi maps no personal assets — the whole triad is skipped", () => {
    // Pi opts out of the mechanism entirely (personalAssets: {}), pending the
    // Phase-3 check of whether it reads Agent Skills SKILL.md.
    const dir = projectWith("skills", "commands", "agents");
    expect(personalAssetPlan(dir, "pi")).toEqual({
      copies: [],
      skipped: ["skills", "commands", "agents"],
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

describe("builtinSkillPlan", () => {
  test("routes the skill into each agent's skills dir under 'cww'", () => {
    expect(builtinSkillPlan("claude", {})?.dest).toBe("/home/developer/.claude/skills/cww");
    expect(builtinSkillPlan("vibe", {})?.dest).toBe("/home/developer/.vibe/skills/cww");
    expect(builtinSkillPlan("opencode", {})?.dest).toBe(
      "/home/developer/.config/opencode/skills/cww",
    );
    expect(builtinSkillPlan("copilot", {})?.dest).toBe("/home/developer/.copilot/skills/cww");
  });

  test("the source is the install's templates/skills/cww, carrying SKILL.md", () => {
    for (const agent of CWW_AGENTS) {
      const plan = builtinSkillPlan(agent, {});
      if (!plan) continue; // an agent that maps no skills dir (e.g. pi) opts out
      expect(plan.src).toBe(path.join(getCwwDir(), "templates", "skills", "cww"));
      expect(fs.existsSync(path.join(plan.src, "SKILL.md"))).toBe(true);
    }
  });

  test("an agent that maps no skills dir opts out of the built-in skill", () => {
    // pi's "Skills" are a different format, so it maps none — the plan is null
    // and the registry skips the built-in cww skill for it (Phase 3 revisits).
    expect(builtinSkillPlan("pi", {})).toBeNull();
  });

  test("references resolve to existing docs in the install (none missing here)", () => {
    const plan = builtinSkillPlan("claude", {})!;
    expect(plan.missingReferences).toEqual([]);
    expect(plan.references.map((r) => path.basename(r))).toEqual([...BUILTIN_SKILL_REFERENCES]);
    for (const ref of plan.references) {
      expect(ref).toBe(path.join(getCwwDir(), "docs", path.basename(ref)));
      expect(fs.existsSync(ref)).toBe(true);
    }
  });

  test("each agent gets only its own troubleshooting doc, or none", () => {
    for (const agent of CWW_AGENTS) {
      const plan = builtinSkillPlan(agent, {});
      if (!plan) continue; // no skill at all (e.g. pi) ⇒ no troubleshooting doc
      const expected = path.join(getCwwDir(), "templates", "agent-troubleshooting", `${agent}.md`);
      // Present or absent, it is never another agent's file.
      expect(plan.troubleshooting).toBe(fs.existsSync(expected) ? expected : null);
    }
    // opencode's notes exist today (the LSP session-lifecycle warnings).
    expect(builtinSkillPlan("opencode", {})!.troubleshooting).not.toBeNull();
  });

  test("CWW_SKILL=off (and friends) opt out", () => {
    for (const value of ["off", "0", "false", "no"]) {
      expect(builtinSkillPlan("claude", { CWW_SKILL: value })).toBeNull();
    }
    expect(builtinSkillPlan("claude", { CWW_SKILL: "on" })).not.toBeNull();
  });
});

describe("skillRefreshPlan", () => {
  // A throwaway repo root, optionally carrying a personal skill named 'cww'.
  function repo(personalCwwSkill = false): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    if (personalCwwSkill) {
      const skill = path.join(dir, ".cww", "skills", "cww");
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: cww\n---\n");
    }
    return dir;
  }

  test("plans the same copy builtinSkillPlan does, for the session's agent", () => {
    const plan = skillRefreshPlan({ agent: "opencode", mainRepo: repo() });
    expect(plan?.dest).toBe("/home/developer/.config/opencode/skills/cww");
    expect(plan?.src).toBe(path.join(getCwwDir(), "templates", "skills", "cww"));
    expect(plan?.references.map((r) => path.basename(r))).toEqual([...BUILTIN_SKILL_REFERENCES]);
  });

  test("a session with no recorded agent is a claude workspace", () => {
    expect(skillRefreshPlan({})?.dest).toBe("/home/developer/.claude/skills/cww");
  });

  test("an agent id cww no longer has refreshes nothing", () => {
    expect(skillRefreshPlan({ agent: "cursor" })).toBeNull();
  });

  test("a personal .cww/skills/cww overrides the built-in one — leave it alone", () => {
    expect(skillRefreshPlan({ agent: "claude", mainRepo: repo(true) })).toBeNull();
    // Only that exact name shadows it.
    expect(skillRefreshPlan({ agent: "claude", mainRepo: repo(false) })).not.toBeNull();
  });

  test("ignores CWW_SKILL — the create-time answer is read off the container", () => {
    const restore = process.env.CWW_SKILL;
    process.env.CWW_SKILL = "off";
    try {
      expect(skillRefreshPlan({ agent: "claude" })).not.toBeNull();
    } finally {
      if (restore === undefined) delete process.env.CWW_SKILL;
      else process.env.CWW_SKILL = restore;
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

  test("no config file forwards a hand-set OPENCODE_CONFIG_CONTENT (its only ride into the container)", () => {
    const env = { OPENCODE_CONFIG_CONTENT: '{"model":"x"}' };
    expect(opencodeContainerEnv(dirWithConfig(), env, dirWithConfig())).toEqual({
      OPENCODE_CONFIG_CONTENT: '{"model":"x"}',
    });
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

  test("the dispatch's optional auth-method argument leaves method-blind agents unchanged", () => {
    // Agents whose hook depends on the chosen method (e.g. BYOK-only vars)
    // receive it as containerEnv's third parameter; the existing agents
    // ignore it, so passing one must be a no-op for them.
    const project = dirWithConfig(CONFIG);
    const method = { id: "api-key", envKey: "ANTHROPIC_API_KEY" };
    expect(agentContainerEnv("opencode", project, {}, method)).toEqual(
      agentContainerEnv("opencode", project, {}),
    );
    expect(agentContainerEnv("claude", project, {}, method)).toEqual({});
    expect(agentContainerEnv("vibe", project, {}, method)).toEqual({});
  });

  test("preflight of the config-file method accepts the config file (warn-and-continue)", () => {
    const project = dirWithConfig(CONFIG);
    const configFileMethod = opencodeAgent.authMethods.find((m) => m.id === "config-file")!;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // Would process.exit(1) without an accepter; returning means accepted.
      expect(opencodeAgent.preflight(project, {}, configFileMethod)).toBeUndefined();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(path.join(project, ".cww", "opencode.json"));
    } finally {
      log.mockRestore();
    }
  });
});

describe("pi config file", () => {
  // Throwaway project and home dirs, optionally carrying a .cww/pi-models.json.
  function dirWithConfig(config?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    if (config !== undefined) {
      fs.mkdirSync(path.join(dir, ".cww"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".cww", "pi-models.json"), config);
    }
    return dir;
  }

  const CONFIG = `{
  "providers": { "llamacpp": { "baseUrl": "http://llamahost:8080/v1", "apiKey": "noop", "api": "openai-completions", "models": [{ "id": "local" }] } }
}`;

  test("the project file beats the global one, then falls back to none", () => {
    const project = dirWithConfig(CONFIG);
    const home = dirWithConfig(CONFIG);
    expect(resolvePiConfigFile(project, home)).toBe(path.join(project, ".cww", "pi-models.json"));
    expect(resolvePiConfigFile(dirWithConfig(), home)).toBe(
      path.join(home, ".cww", "pi-models.json"),
    );
    expect(resolvePiConfigFile(dirWithConfig(), dirWithConfig())).toBeNull();
  });

  test("configFile resolves to the container's models.json dest when a file is present", () => {
    // A project carrying the file is resolved first, regardless of $HOME — so
    // this stays robust without isolating home (the null path is covered by the
    // explicit-home resolvePiConfigFile test above).
    const project = dirWithConfig(CONFIG);
    expect(piAgent.configFile!(project, {})).toEqual({
      src: path.join(project, ".cww", "pi-models.json"),
      dest: "/home/developer/.pi/agent/models.json",
    });
  });

  test("the registry dispatch reaches pi's hook, and other agents contribute nothing", () => {
    const project = dirWithConfig(CONFIG);
    expect(agentConfigFile("pi", project)?.dest).toBe("/home/developer/.pi/agent/models.json");
    expect(agentConfigFile("opencode", project)).toBeNull();
    expect(agentConfigFile("claude", project)).toBeNull();
  });

  test("preflight of the config-file method accepts a present file (warn-and-continue)", () => {
    const project = dirWithConfig(CONFIG);
    const configFileMethod = piAgent.authMethods.find((m) => m.id === "config-file")!;
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(piAgent.preflight(project, {}, configFileMethod)).toBeUndefined();
      expect(log.mock.calls.flat().join("\n")).toContain(
        path.join(project, ".cww", "pi-models.json"),
      );
    } finally {
      log.mockRestore();
    }
  });

  test("preflight ignores a missing file for a provider-key method", () => {
    const apiKey = piAgent.authMethods.find((m) => m.id === "anthropic-api-key")!;
    expect(piAgent.preflight(dirWithConfig(), {}, apiKey)).toBeUndefined();
  });

  test("the config-file method without any file dies, naming both config paths", () => {
    // process.exit path — probe in a subprocess, like the opencode JSON test.
    const project = dirWithConfig();
    const agentMod = path.join(import.meta.dir, "..", "src", "agents", "pi", "agent.ts");
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `const { piAgent } = await import(${JSON.stringify(agentMod)}); piAgent.preflight(${JSON.stringify(project)}, {}, { id: "config-file" })`,
      ],
      stderr: "pipe",
      env: { ...process.env, HOME: project }, // no real ~/.cww/pi-models.json in reach
    });
    expect(r.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(r.stderr);
    expect(stderr).toContain("pi-models.json");
    expect(stderr).toContain("anthropic-api-key");
  });

  test("invalid JSON in a present file dies loudly pre-create, naming the file", () => {
    const project = dirWithConfig('{"providers": '); // truncated
    const agentMod = path.join(import.meta.dir, "..", "src", "agents", "pi", "agent.ts");
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `const { piAgent } = await import(${JSON.stringify(agentMod)}); piAgent.preflight(${JSON.stringify(project)}, {}, { id: "anthropic-api-key" })`,
      ],
      stderr: "pipe",
      env: { ...process.env, HOME: project },
    });
    expect(r.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(r.stderr);
    expect(stderr).toContain("Invalid JSON");
    expect(stderr).toContain(path.join(project, ".cww", "pi-models.json"));
  });
});

describe("parseAgentVersion", () => {
  // The real --version output of each image, captured 2026-07-26.
  test("reduces every agent's --version spelling to the bare version", () => {
    expect(parseAgentVersion("2.1.216 (Claude Code)")).toBe("2.1.216");
    expect(parseAgentVersion("vibe 2.22.0")).toBe("2.22.0");
    expect(parseAgentVersion("1.18.4")).toBe("1.18.4");
    // Trailing period, plus copilot's second line nagging about updates.
    expect(parseAgentVersion("GitHub Copilot CLI 1.0.73.\nRun 'copilot update' to check\n")).toBe(
      "1.0.73",
    );
  });

  test("keeps prerelease and build suffixes", () => {
    expect(parseAgentVersion("3.0.0-beta.2")).toBe("3.0.0-beta.2");
    expect(parseAgentVersion("cli 1.2.3+build7 (x64)")).toBe("1.2.3+build7");
  });

  test("falls back to the first line when nothing looks like a version", () => {
    expect(parseAgentVersion("  unreleased build \n more\n")).toBe("unreleased build");
    expect(parseAgentVersion("")).toBe("");
  });
});

describe("agentBuildPlan", () => {
  test("builds the shared base first, then the agent's own folder", () => {
    expect(agentBuildPlan("vibe")).toEqual([
      { tag: "cww-base:latest", context: path.join("docker", "base"), flags: ["--pull"] },
      {
        tag: "coder-workspace-workflow:vibe",
        context: path.join("src", "agents", "vibe"),
        flags: ["--no-cache"],
      },
    ]);
  });

  // The default is fresh: an unpinned CLI that a cache hit freezes forever is
  // the whole reason 'cww build' exists (docs/backlog.md). Only the agent step
  // is busted — a --no-cache base would redo apt/node/bun/Temurin every time.
  test("fresh by default: --pull the base, --no-cache the agent's CLI layer", () => {
    for (const agent of CWW_AGENTS) {
      const [base, own] = agentBuildPlan(agent);
      expect(base!.flags).toEqual(["--pull"]);
      expect(base!.flags).not.toContain("--no-cache");
      expect(own!.flags).toEqual(["--no-cache"]);
    }
  });

  test("--cached passes no cache flags at all", () => {
    for (const step of agentBuildPlan("claude", { cached: true })) {
      expect(step.flags).toEqual([]);
    }
  });

  test("every step's build context exists and carries a Dockerfile", () => {
    for (const agent of CWW_AGENTS) {
      for (const step of agentBuildPlan(agent)) {
        expect(fs.existsSync(path.join(getCwwDir(), step.context, "Dockerfile"))).toBe(true);
      }
    }
  });

  // The host reads this path; only the Dockerfiles write it. A new agent that
  // skips the stamp reports '?' forever, which is exactly the kind of silent
  // gap this catches.
  test("every agent image stamps its CLI version at the path the host reads", () => {
    for (const agent of CWW_AGENTS) {
      const dockerfile = fs.readFileSync(
        path.join(getCwwDir(), "src", "agents", agent, "Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toContain(`> ${AGENT_VERSION_FILE}`);
    }
  });
});

describe("claude model config", () => {
  // A throwaway project dir plus a config.json carrying (or not) an entry for
  // it — keyed by realpath, exactly as user-config.ts writes it.
  function project(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  }
  function configWith(projectPath: string, entry?: Record<string, unknown>): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-")), "config.json");
    if (entry) {
      const key = fs.realpathSync(projectPath);
      fs.writeFileSync(file, JSON.stringify({ projects: { [key]: entry } }));
    }
    return file;
  }

  test("nothing configured injects nothing", () => {
    const p = project();
    expect(claudeContainerEnv(p, {}, configWith(p))).toEqual({});
  });

  test("global env vars pass through, each independently", () => {
    const p = project();
    const file = configWith(p);
    expect(
      claudeContainerEnv(p, { ANTHROPIC_MODEL: "opus", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" }, file),
    ).toEqual({ ANTHROPIC_MODEL: "opus", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" });
    expect(claudeContainerEnv(p, { CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8" }, file)).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-4-8",
    });
  });

  test("project config beats the global env, per field", () => {
    const p = project();
    const file = configWith(p, { model: "claude-opus-4-8" });
    expect(
      claudeContainerEnv(p, { ANTHROPIC_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" }, file),
    ).toEqual({ ANTHROPIC_MODEL: "claude-opus-4-8", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" });
  });

  test("subagentModel in project config works without model", () => {
    const p = project();
    const file = configWith(p, { subagentModel: "sonnet" });
    expect(claudeContainerEnv(p, {}, file)).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" });
  });

  test("empty strings don't leak into the container", () => {
    const p = project();
    expect(
      claudeContainerEnv(p, { ANTHROPIC_MODEL: "", CLAUDE_CODE_SUBAGENT_MODEL: "" }, configWith(p)),
    ).toEqual({});
  });

  test("another project's entry doesn't apply", () => {
    const p = project();
    const other = project();
    const file = configWith(other, { model: "opus" });
    expect(claudeContainerEnv(p, {}, file)).toEqual({});
  });
});

describe("copilot provider config", () => {
  // Same throwaway project/config.json helpers as the claude model tests.
  function project(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  }
  function configWith(projectPath: string, entry?: Record<string, unknown>): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-")), "config.json");
    if (entry) {
      const key = fs.realpathSync(projectPath);
      fs.writeFileSync(file, JSON.stringify({ projects: { [key]: entry } }));
    }
    return file;
  }

  const provider = copilotAgent.authMethods.find((m) => m.id === "provider")!;
  const providerKey = copilotAgent.authMethods.find((m) => m.id === "provider-key")!;
  const githubToken = copilotAgent.authMethods.find((m) => m.id === "github-token")!;
  const BYOK_ENV = {
    COPILOT_PROVIDER_BASE_URL: "http://llamahost:8080/v1",
    COPILOT_MODEL: "qwen3.6-35b-a3b",
  };

  test("BYOK methods get the endpoint, the model, and offline by default", () => {
    const p = project();
    const file = configWith(p);
    for (const method of [provider, providerKey]) {
      expect(copilotContainerEnv(p, BYOK_ENV, method, file)).toEqual({
        COPILOT_MODEL: "qwen3.6-35b-a3b",
        COPILOT_PROVIDER_BASE_URL: "http://llamahost:8080/v1",
        COPILOT_OFFLINE: "true",
      });
    }
  });

  test("github-token gets the model only — the base URL would hijack it into BYOK", () => {
    const p = project();
    expect(copilotContainerEnv(p, BYOK_ENV, githubToken, configWith(p))).toEqual({
      COPILOT_MODEL: "qwen3.6-35b-a3b",
    });
    // No method (older callers) is treated the same as a non-BYOK one.
    expect(copilotContainerEnv(p, BYOK_ENV, undefined, configWith(p))).toEqual({
      COPILOT_MODEL: "qwen3.6-35b-a3b",
    });
  });

  test("an explicit COPILOT_OFFLINE is forwarded verbatim instead of the default", () => {
    const p = project();
    const env = { ...BYOK_ENV, COPILOT_OFFLINE: "false" };
    expect(copilotContainerEnv(p, env, provider, configWith(p)).COPILOT_OFFLINE).toBe("false");
  });

  test("project config beats the global env, per field", () => {
    const p = project();
    const file = configWith(p, { providerBaseUrl: "http://other:9090/v1" });
    expect(copilotContainerEnv(p, BYOK_ENV, provider, file)).toEqual({
      COPILOT_MODEL: "qwen3.6-35b-a3b",
      COPILOT_PROVIDER_BASE_URL: "http://other:9090/v1",
      COPILOT_OFFLINE: "true",
    });
  });

  test("nothing configured injects only the offline default for BYOK, nothing for github-token", () => {
    const p = project();
    expect(copilotContainerEnv(p, {}, provider, configWith(p))).toEqual({ COPILOT_OFFLINE: "true" });
    expect(copilotContainerEnv(p, {}, githubToken, configWith(p))).toEqual({});
  });

  test("empty strings don't leak into the container", () => {
    const p = project();
    const env = { COPILOT_PROVIDER_BASE_URL: "", COPILOT_MODEL: "" };
    expect(copilotContainerEnv(p, env, githubToken, configWith(p))).toEqual({});
  });

  test("the non-secret BYOK knobs are forwarded verbatim, secrets and unknowns are not", () => {
    const p = project();
    const env = {
      ...BYOK_ENV,
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "60000",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_HEADERS: "X-Tenant-Id: mai",
      COPILOT_PROVIDER_MAX_PROMT_TOKENS: "typo", // not forwarded — allowlist, not prefix
      COPILOT_PROVIDER_API_KEY: "sk-secret", // rides the auth channel, never this one
      COPILOT_PROVIDER_BEARER_TOKEN: "bearer-secret",
    };
    expect(copilotContainerEnv(p, env, provider, configWith(p))).toEqual({
      COPILOT_MODEL: "qwen3.6-35b-a3b",
      COPILOT_PROVIDER_BASE_URL: "http://llamahost:8080/v1",
      COPILOT_OFFLINE: "true",
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "60000",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_HEADERS: "X-Tenant-Id: mai",
    });
  });

  test("the BYOK knobs stay out of a github-token workspace", () => {
    const p = project();
    const env = { ...BYOK_ENV, COPILOT_PROVIDER_TYPE: "azure", COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "8000" };
    expect(copilotContainerEnv(p, env, githubToken, configWith(p))).toEqual({
      COPILOT_MODEL: "qwen3.6-35b-a3b",
    });
  });

  test("preflight accepts a configured BYOK endpoint (warn-and-continue for the keyless method)", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(copilotAgent.preflight(project(), BYOK_ENV, provider)).toBeUndefined();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("No key injected");
      expect(output).toContain("http://llamahost:8080/v1");
    } finally {
      log.mockRestore();
    }
  });

  test("preflight nudges toward provider-key when a key is stored but 'provider' was chosen", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      copilotAgent.preflight(project(), { ...BYOK_ENV, COPILOT_PROVIDER_API_KEY: "k" }, provider);
      expect(log.mock.calls.flat().join("\n")).toContain("provider-key");
    } finally {
      log.mockRestore();
    }
  });

  test("preflight ignores BYOK prerequisites for github-token", () => {
    expect(copilotAgent.preflight(project(), {}, githubToken)).toBeUndefined();
  });

  test("a BYOK method without endpoint/model dies loudly, naming the missing vars", () => {
    // process.exit path — probe in a subprocess, like the opencode JSON test.
    const p = project();
    const agentMod = path.join(import.meta.dir, "..", "src", "agents", "copilot", "agent.ts");
    const r = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `const { copilotAgent } = await import(${JSON.stringify(agentMod)}); copilotAgent.preflight(${JSON.stringify(p)}, {}, { id: "provider" })`,
      ],
      stderr: "pipe",
      env: { ...process.env, HOME: p }, // no real ~/.cww/config.json in reach
    });
    expect(r.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(r.stderr);
    expect(stderr).toContain("COPILOT_PROVIDER_BASE_URL");
    expect(stderr).toContain("COPILOT_MODEL");
    expect(stderr).toContain("providerBaseUrl");
  });
});
