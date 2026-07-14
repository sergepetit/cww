import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendGlobalHost, hostsEntries, parseHostsEntries } from "../src/lib/hosts";

describe("hosts files", () => {
  let dir: string;
  let globalFile: string;
  let project: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-hosts-"));
    globalFile = path.join(dir, "hosts");
    project = path.join(dir, "repo");
    fs.mkdirSync(path.join(project, ".cww"), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("hostsEntries merges global then project file, missing files skipped", () => {
    expect(hostsEntries(project, globalFile)).toEqual([]);
    fs.writeFileSync(globalFile, "forge 192.0.2.10\n");
    fs.writeFileSync(path.join(project, ".cww", "hosts"), "# team hosts\nregistry 10.0.0.2\n");
    expect(hostsEntries(project, globalFile)).toEqual([
      { host: "forge", ip: "192.0.2.10" },
      { host: "registry", ip: "10.0.0.2" },
    ]);
  });

  test("appendGlobalHost creates the file with a header, then appends", () => {
    appendGlobalHost("forge", "192.0.2.10", globalFile);
    const first = fs.readFileSync(globalFile, "utf8");
    expect(first.startsWith("#")).toBe(true);
    expect(parseHostsEntries(first)).toEqual([{ host: "forge", ip: "192.0.2.10" }]);

    appendGlobalHost("registry", "10.0.0.2", globalFile);
    expect(parseHostsEntries(fs.readFileSync(globalFile, "utf8"))).toEqual([
      { host: "forge", ip: "192.0.2.10" },
      { host: "registry", ip: "10.0.0.2" },
    ]);
  });

  test("appendGlobalHost tolerates a hand-written file without trailing newline", () => {
    fs.writeFileSync(globalFile, "existing 10.0.0.1");
    appendGlobalHost("forge", "192.0.2.10", globalFile);
    expect(parseHostsEntries(fs.readFileSync(globalFile, "utf8"))).toEqual([
      { host: "existing", ip: "10.0.0.1" },
      { host: "forge", ip: "192.0.2.10" },
    ]);
  });
});
