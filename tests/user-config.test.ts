import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProjectConfig,
  parseUserConfig,
  projectKey,
  readUserConfig,
  setProjectConfig,
} from "../src/lib/user-config";

describe("parseUserConfig", () => {
  test("tolerates a missing projects map and keeps unknown fields", () => {
    expect(parseUserConfig("{}")).toEqual({ projects: {} });
    const cfg = parseUserConfig('{"future": 1, "projects": {"/a": {"repoUrl": "u", "x": 2}}}');
    expect(cfg.future).toBe(1);
    expect(cfg.projects["/a"]).toEqual({ repoUrl: "u", x: 2 });
  });

  test("rejects non-object shapes", () => {
    expect(() => parseUserConfig("[]")).toThrow();
    expect(() => parseUserConfig('"str"')).toThrow();
    expect(() => parseUserConfig('{"projects": []}')).toThrow();
    expect(() => parseUserConfig("not json")).toThrow();
  });
});

describe("read/get/set round-trip", () => {
  let dir: string;
  let file: string;
  let repo: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    file = path.join(dir, "config.json");
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-repo-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("missing file reads as empty; set creates it and get finds the entry", () => {
    expect(readUserConfig(file)).toEqual({ projects: {} });
    expect(getProjectConfig(repo, file)).toBeNull();

    setProjectConfig(repo, { repoUrl: "https://host/org/repo.git" }, file);
    expect(getProjectConfig(repo, file)).toEqual({ repoUrl: "https://host/org/repo.git" });
  });

  test("set merges over the existing entry and preserves other projects", () => {
    setProjectConfig(repo, { repoUrl: "u1", agent: "vibe" }, file);
    setProjectConfig("/somewhere/else", { repoUrl: "u2" }, file);
    setProjectConfig(repo, { repoUrl: "u1-rotated" }, file);

    expect(getProjectConfig(repo, file)).toEqual({ repoUrl: "u1-rotated", agent: "vibe" });
    expect(readUserConfig(file).projects[projectKey("/somewhere/else")]).toEqual({ repoUrl: "u2" });
  });

  test("keys by realpath, so a symlinked path hits the same entry", () => {
    setProjectConfig(repo, { repoUrl: "u" }, file);
    const link = path.join(dir, "link-to-repo");
    fs.symlinkSync(repo, link);
    expect(getProjectConfig(link, file)).toEqual({ repoUrl: "u" });
  });
});
