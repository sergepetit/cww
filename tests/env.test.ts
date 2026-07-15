import { describe, expect, test } from "bun:test";
import { parseEnvFile, upsertEnvLine } from "../src/lib/env";

describe("parseEnvFile", () => {
  test("parses KEY=VALUE lines, skipping comments and blanks", () => {
    const parsed = parseEnvFile(
      [
        "# git credential",
        "CWW_GIT_USER=dev",
        "",
        "CWW_GIT_TOKEN=abc123",
        "export CWW_AGENT=vibe",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      CWW_GIT_USER: "dev",
      CWW_GIT_TOKEN: "abc123",
      CWW_AGENT: "vibe",
    });
  });

  test("strips matching quotes but keeps inner content verbatim", () => {
    const parsed = parseEnvFile(['A="hello world"', "B='x=y'", 'C="unterminated'].join("\n"));
    expect(parsed.A).toBe("hello world");
    expect(parsed.B).toBe("x=y");
    expect(parsed.C).toBe('"unterminated');
  });

  test("ignores non-assignment lines instead of failing", () => {
    const parsed = parseEnvFile(["if something; then", "VALID=1", "fi"].join("\n"));
    expect(parsed).toEqual({ VALID: "1" });
  });
});

describe("upsertEnvLine", () => {
  test("replaces the key's line in place, preserving everything else", () => {
    const text = ["# tokens", "CLAUDE_CODE_OAUTH_TOKEN=old", "", "CWW_AGENT=vibe", ""].join("\n");
    expect(upsertEnvLine(text, "CLAUDE_CODE_OAUTH_TOKEN", "new")).toBe(
      ["# tokens", "CLAUDE_CODE_OAUTH_TOKEN=new", "", "CWW_AGENT=vibe", ""].join("\n"),
    );
  });

  test("keeps an 'export ' prefix on the rewritten line", () => {
    expect(upsertEnvLine("export A=1\n", "A", "2")).toBe("export A=2\n");
  });

  test("appends when the key is absent, ending with a newline", () => {
    expect(upsertEnvLine("A=1\n", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvLine("A=1", "B", "2")).toBe("A=1\nB=2\n");
    expect(upsertEnvLine("", "B", "2")).toBe("B=2\n");
  });

  test("drops duplicate assignments of the same key", () => {
    expect(upsertEnvLine("A=1\nB=x\nA=2\n", "A", "3")).toBe("A=3\nB=x\n");
  });

  test("does not touch keys that merely share a prefix", () => {
    expect(upsertEnvLine("AB=1\n", "A", "2")).toBe("AB=1\nA=2\n");
  });
});
