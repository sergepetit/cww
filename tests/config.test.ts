import { describe, expect, test } from "bun:test";
import { browserEnabled } from "../src/lib/config";

describe("browserEnabled", () => {
  test("defaults to on", () => {
    expect(browserEnabled({})).toBe(true);
  });

  test("off/0/false/no disable it", () => {
    for (const value of ["off", "0", "false", "no"]) {
      expect(browserEnabled({ CWW_BROWSER: value })).toBe(false);
    }
  });

  test("anything else keeps it on (case-sensitive, like the bash lib)", () => {
    expect(browserEnabled({ CWW_BROWSER: "on" })).toBe(true);
    expect(browserEnabled({ CWW_BROWSER: "OFF" })).toBe(true);
  });
});
