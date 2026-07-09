import { describe, expect, test } from "bun:test";
import { parseEnvFile } from "../src/lib/env";

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
