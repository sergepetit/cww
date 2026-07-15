import { describe, expect, test } from "bun:test";
import { agentAuthMethods } from "../src/agents/registry";
import type { AgentAuthMethod } from "../src/agents/types";
import { chooseAuthMethod } from "../src/lib/auth-flow";

// A synthetic agent with the interesting shapes: an envKey default, an
// envKey alternative, and a keyless method.
const METHODS: readonly AgentAuthMethod[] = [
  { id: "token", envKey: "TOKEN_A" },
  { id: "key", envKey: "KEY_B" },
  { id: "none" },
];

describe("chooseAuthMethod", () => {
  test("the flag wins over everything", () => {
    const c = chooseAuthMethod({
      methods: METHODS,
      flag: "key",
      project: "token",
      globalDefault: "none",
      env: { TOKEN_A: "set" },
    });
    expect(c.method?.id).toBe("key");
    expect(c.source).toBe("flag");
    expect(c.warnings).toEqual([]);
  });

  test("project config beats the global default", () => {
    const c = chooseAuthMethod({
      methods: METHODS,
      project: "none",
      globalDefault: "key",
      env: {},
    });
    expect(c.method?.id).toBe("none");
    expect(c.source).toBe("project");
  });

  test("an unknown project value warns and falls through to the global default", () => {
    const c = chooseAuthMethod({
      methods: METHODS,
      project: "oauth-token", // e.g. written for a different agent
      globalDefault: "key",
      env: {},
    });
    expect(c.method?.id).toBe("key");
    expect(c.source).toBe("global");
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain("oauth-token");
    expect(c.warnings[0]).toContain("~/.cww/config.json");
  });

  test("a single-method agent needs no configuration", () => {
    const c = chooseAuthMethod({ methods: [METHODS[0]!], env: {} });
    expect(c.method?.id).toBe("token");
    expect(c.source).toBe("only");
  });

  test("the default method is auto-picked when its key is stored", () => {
    const c = chooseAuthMethod({ methods: METHODS, env: { TOKEN_A: "set" } });
    expect(c.method?.id).toBe("token");
    expect(c.source).toBe("default");
  });

  test("a non-default method's key alone decides nothing — no implicit opt-in", () => {
    // The original footgun: only KEY_B present must NOT pick 'key'.
    const c = chooseAuthMethod({ methods: METHODS, env: { KEY_B: "set" } });
    expect(c.method).toBeNull();
    expect(c.source).toBeNull();
  });

  test("nothing configured and no default key means: ask", () => {
    expect(chooseAuthMethod({ methods: METHODS, env: {} }).method).toBeNull();
  });

  test("claude with only an ANTHROPIC_API_KEY never silently gets metered billing", () => {
    // The real-world shape of the footgun this plan removes: an API key set
    // for opencode must not become claude's credential as a side effect.
    const c = chooseAuthMethod({
      methods: agentAuthMethods("claude"),
      env: { ANTHROPIC_API_KEY: "sk-ant-..." },
    });
    expect(c.method).toBeNull();
  });

  test("claude with the oauth token stored resolves without asking", () => {
    const c = chooseAuthMethod({
      methods: agentAuthMethods("claude"),
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-...", ANTHROPIC_API_KEY: "sk-ant-..." },
    });
    expect(c.method?.id).toBe("oauth-token");
    expect(c.source).toBe("default");
  });
});
