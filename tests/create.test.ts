import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCwwDir } from "../src/agents/registry";
import {
  declaredCacheDirs,
  generateAgentEnvOverride,
  renderTemplate,
  servicesDeclareBuild,
} from "../src/commands/create";
import { parseHostsEntries } from "../src/lib/hosts";
import { containerHostname } from "../src/lib/naming";

describe("compose template placeholders", () => {
  test("every {{PLACEHOLDER}} in the template is one generateCompose fills", () => {
    const template = fs.readFileSync(
      path.join(getCwwDir(), "templates", "docker-compose.yml.template"),
      "utf8",
    );
    // Must match the vars generateCompose passes to renderTemplate — a
    // placeholder outside this list would survive rendering verbatim.
    const filled = [
      "TASK_DIR",
      "CONTAINER_NAME",
      "CONTAINER_HOSTNAME",
      "CWW_IMAGE",
      "WORKSPACE_NAME",
      "BRANCH_NAME",
      "REPO_URL",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "CWW_BROWSER",
      "CWW_BROWSER_RESOLUTION",
      "HOME",
    ];
    for (const p of template.match(/\{\{[A-Z_]+\}\}/g) ?? []) {
      expect(filled).toContain(p.slice(2, -2));
    }
  });

  test("the global ~/.cww/env is no longer an env_file (agent-env scoping)", () => {
    const template = fs.readFileSync(
      path.join(getCwwDir(), "templates", "docker-compose.yml.template"),
      "utf8",
    );
    expect(template).not.toContain("{{HOME}}/.cww/env");
    expect(template).toContain("{{HOME}}/.cww/services.env");
    expect(template).toContain("{{TASK_DIR}}/env");
  });
});

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

describe("servicesDeclareBuild", () => {
  test("detects a build: key, block or inline form", () => {
    const block = `
services:
  api:
    build:
      context: ../api
`;
    const inline = `
services:
  api:
    build: ../api
`;
    expect(servicesDeclareBuild(block)).toBe(true);
    expect(servicesDeclareBuild(inline)).toBe(true);
  });

  test("image-based services pass", () => {
    const yaml = `
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: todo_dev
`;
    expect(servicesDeclareBuild(yaml)).toBe(false);
    expect(servicesDeclareBuild("")).toBe(false);
  });

  test("comments and build-prefixed words don't trigger", () => {
    const yaml = `
services:
  ci:
    # build: happens elsewhere; this service only runs prebuilt images
    image: builder:1
    environment:
      builder_mode: fast
`;
    expect(servicesDeclareBuild(yaml)).toBe(false);
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
