import { describe, expect, test } from "bun:test";
import {
  getContainerName,
  getTaskName,
  normalizeGitUrl,
  sanitizeName,
} from "../src/lib/naming";

describe("sanitizeName", () => {
  test("lowercases and keeps [a-z0-9-]", () => {
    expect(sanitizeName("hello-world")).toBe("hello-world");
    expect(sanitizeName("Hello World")).toBe("hello-world");
  });

  test("maps slashes to dashes (branch-like names)", () => {
    expect(sanitizeName("feature/Login-Form")).toBe("feature-login-form");
  });

  test("replaces every other character with a dash", () => {
    expect(sanitizeName("My_App.2")).toBe("my-app-2");
    expect(sanitizeName("a@b#c")).toBe("a-b-c");
  });
});

describe("container and task names", () => {
  test("container name is cww-<project>-<workspace>", () => {
    expect(getContainerName("My App", "fix/bug")).toBe("cww-my-app-fix-bug");
  });

  test("task name is <project>-<workspace>", () => {
    expect(getTaskName("My App", "fix/bug")).toBe("my-app-fix-bug");
  });
});

describe("normalizeGitUrl", () => {
  test("rewrites scp-style ssh remotes to https", () => {
    expect(normalizeGitUrl("git@github.com:org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  test("rewrites ssh:// remotes to https", () => {
    expect(normalizeGitUrl("ssh://git@git.example.com/org/repo.git")).toBe(
      "https://git.example.com/org/repo.git",
    );
  });

  test("drops the SSH port of ssh:// remotes (web is assumed on 443)", () => {
    expect(normalizeGitUrl("ssh://git@git.example.com:2222/org/repo.git")).toBe(
      "https://git.example.com/org/repo.git",
    );
  });

  test("leaves https remotes and local paths untouched", () => {
    expect(normalizeGitUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
    expect(normalizeGitUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });
});
