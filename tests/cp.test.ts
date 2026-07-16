// The pure planning half of 'cww cp': the scp-style argument parser and the
// in-container path resolution. No Docker anywhere — the copy helpers in
// container-fs.ts are exercised by the manual verify flow instead.

import { describe, expect, test } from "bun:test";
import { parseCpArgs, resolveContainerPath } from "../src/commands/cp";

describe("resolveContainerPath", () => {
  test("relative paths resolve against /workspace", () => {
    expect(resolveContainerPath("docs/notes.md")).toBe("/workspace/docs/notes.md");
  });

  test("absolute paths pass through", () => {
    expect(resolveContainerPath("/tmp/x")).toBe("/tmp/x");
  });

  test("empty path (bare 'ws:') means /workspace", () => {
    expect(resolveContainerPath("")).toBe("/workspace");
  });

  test("trailing slash survives (marks a directory)", () => {
    expect(resolveContainerPath("docs/")).toBe("/workspace/docs/");
  });
});

describe("parseCpArgs", () => {
  test("remote dest → push", () => {
    expect(parseCpArgs(["notes.md", "sandbox:docs/"])).toEqual({
      direction: "push",
      workspace: "sandbox",
      sources: ["notes.md"],
      dest: "/workspace/docs/",
    });
  });

  test("bare 'ws:' dest pushes to /workspace", () => {
    expect(parseCpArgs(["notes.md", "sandbox:"]).dest).toBe("/workspace");
  });

  test("empty workspace name means auto-detect", () => {
    const plan = parseCpArgs(["notes.md", ":docs/"]);
    expect(plan.workspace).toBeUndefined();
    expect(plan.direction).toBe("push");
  });

  test("multiple push sources are kept in order", () => {
    expect(parseCpArgs(["a.txt", "b.txt", "ws:data/"]).sources).toEqual(["a.txt", "b.txt"]);
  });

  test("remote source → pull, path resolved against /workspace", () => {
    expect(parseCpArgs(["sandbox:out.log", "."])).toEqual({
      direction: "pull",
      workspace: "sandbox",
      sources: ["/workspace/out.log"],
      dest: ".",
    });
  });

  test("pull with several sources from the same workspace", () => {
    const plan = parseCpArgs(["ws:a.log", "ws:b.log", "out/"]);
    expect(plan.direction).toBe("pull");
    expect(plan.sources).toEqual(["/workspace/a.log", "/workspace/b.log"]);
  });

  test("pull sources naming different workspaces are rejected", () => {
    expect(() => parseCpArgs(["ws1:a", "ws2:b", "out/"])).toThrow(/same workspace/);
  });

  test("mixing remote and host sources is rejected", () => {
    expect(() => parseCpArgs(["ws:a", "local.txt", "out/"])).toThrow(/mix/i);
  });

  test("both sides remote is rejected", () => {
    expect(() => parseCpArgs(["ws1:a", "ws2:b"])).toThrow(/workspace-to-workspace/);
  });

  test("neither side remote is rejected with a syntax hint", () => {
    expect(() => parseCpArgs(["a.txt", "b.txt"])).toThrow(/<workspace>:<path>/);
  });

  test("fewer than two arguments is rejected", () => {
    expect(() => parseCpArgs(["only-one"])).toThrow(/source and a destination/);
  });

  test("'./' prefix escapes a literal colon in a host path", () => {
    const plan = parseCpArgs(["./with:colon", "ws:"]);
    expect(plan.direction).toBe("push");
    expect(plan.sources).toEqual(["./with:colon"]);
  });

  test("a path separator before the colon means a host path", () => {
    expect(() => parseCpArgs(["dir/with:colon", "other.txt"])).toThrow(/<workspace>:<path>/);
  });
});
