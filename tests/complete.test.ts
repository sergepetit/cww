import { describe, expect, test } from "bun:test";
import { workspaceNames } from "../src/commands/complete";

describe("workspaceNames", () => {
  test("collects, dedupes, and sorts workspace names", () => {
    expect(
      workspaceNames([
        { workspace: "review" },
        { workspace: "sandbox" },
        { workspace: "review" },
      ]),
    ).toEqual(["review", "sandbox"]);
  });

  test("falls back to branch for pre-rename sessions", () => {
    expect(workspaceNames([{ branch: "feature-x" }])).toEqual(["feature-x"]);
  });

  test("skips sessions with neither workspace nor branch", () => {
    expect(workspaceNames([{}, { workspace: "sandbox" }])).toEqual(["sandbox"]);
  });
});
