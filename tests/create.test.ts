import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  declaredCacheDirs,
  generateAgentEnvOverride,
  parseHostsEntries,
  renderTemplate,
} from "../src/commands/create";
import { containerHostname } from "../src/lib/naming";

describe("containerHostname", () => {
  test("passes short names through", () => {
    expect(containerHostname("cww-proj-sandbox")).toBe("cww-proj-sandbox");
  });

  test("truncates to 63 chars", () => {
    const long = `cww-${"a".repeat(100)}`;
    expect(containerHostname(long)).toHaveLength(63);
  });

  test("strips dashes left dangling by the cut", () => {
    const name = `${"a".repeat(61)}--tail`; // cut at 63 lands on the dashes
    expect(containerHostname(name)).toBe("a".repeat(61));
  });
});

describe("parseHostsEntries", () => {
  test("parses 'hostname ip' lines, skipping comments and blanks", () => {
    const entries = parseHostsEntries(
      ["# internal hosts", "buildbox 192.0.2.10", "", "registry 10.0.0.2 trailing", "orphan"].join(
        "\n",
      ),
    );
    expect(entries).toEqual([
      { host: "buildbox", ip: "192.0.2.10" },
      { host: "registry", ip: "10.0.0.2" },
    ]);
  });
});

describe("declaredCacheDirs", () => {
  test("extracts ${HOME} and $HOME cache mounts, deduplicated and expanded", () => {
    const yaml = `
services:
  coder:
    volumes:
      - \${HOME}/.cww/cache/npm/_cacache:/home/developer/.npm/_cacache
      - $HOME/.cww/cache/m2/repository:/home/developer/.m2/repository
      - \${HOME}/.cww/cache/npm/_cacache:/somewhere/else
      - /plain/host/dir:/container/dir
`;
    expect(declaredCacheDirs(yaml, "/home/dev")).toEqual([
      "/home/dev/.cww/cache/m2/repository",
      "/home/dev/.cww/cache/npm/_cacache",
    ]);
  });

  test("empty yaml yields nothing", () => {
    expect(declaredCacheDirs("", "/home/dev")).toEqual([]);
  });
});

describe("generateAgentEnvOverride", () => {
  const overrideFile = (taskDir: string) => path.join(taskDir, "docker-compose.agent.yml");

  test("writes an environment override whose value round-trips", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    // Realistic payload: minified JSON with quotes, a $schema key, and a URL.
    const value =
      '{"$schema":"https://opencode.ai/config.json","provider":{"llama.cpp":{"options":{"baseURL":"http://llamahost:8080/v1"}}}}';
    generateAgentEnvOverride(taskDir, { OPENCODE_CONFIG_CONTENT: value });

    const yaml = fs.readFileSync(overrideFile(taskDir), "utf8");
    expect(yaml).toContain("services:\n  coder:\n    environment:\n");
    const entry = yaml.split("\n").find((l) => l.trimStart().startsWith("- "))!;
    // The entry is a double-quoted scalar written with JSON.stringify, so
    // JSON.parse is a YAML-compatible parse of it; compose then collapses the
    // doubled $ during interpolation.
    const scalar = JSON.parse(entry.trim().slice(2)) as string;
    expect(scalar.replaceAll("$$", "$")).toBe(`OPENCODE_CONFIG_CONTENT=${value}`);
  });

  test("escapes $ so compose interpolation can't eat it", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    generateAgentEnvOverride(taskDir, { KEY: 'a "$schema" and ${HOME}' });
    const yaml = fs.readFileSync(overrideFile(taskDir), "utf8");
    expect(yaml).toContain("$$schema");
    expect(yaml).toContain("$${HOME}");
    expect(yaml).not.toMatch(/[^$]\$[^$]/); // no lone $ left for compose
  });

  test("no entries removes a stale override file", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    generateAgentEnvOverride(taskDir, { KEY: "value" });
    expect(fs.existsSync(overrideFile(taskDir))).toBe(true);
    generateAgentEnvOverride(taskDir, {});
    expect(fs.existsSync(overrideFile(taskDir))).toBe(false);
  });
});

describe("renderTemplate", () => {
  test("fills placeholders, repeats included", () => {
    const out = renderTemplate("name: {{NAME}}\nhost: {{NAME}}\nimage: {{IMG}}", {
      NAME: "cww-x",
      IMG: "img:tag",
    });
    expect(out).toBe("name: cww-x\nhost: cww-x\nimage: img:tag");
  });

  test("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("a: {{KNOWN}} b: {{UNKNOWN}}", { KNOWN: "v" })).toBe(
      "a: v b: {{UNKNOWN}}",
    );
  });
});
