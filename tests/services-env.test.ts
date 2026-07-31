import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  globalServicesEnvFile,
  projectServicesEnvFile,
  servicesEnvFiles,
  workspaceServicesEnvFile,
} from "../src/lib/services-env";

describe("services env layers", () => {
  const home = "/home/dev";

  test("the three layers resolve to their documented paths", () => {
    expect(globalServicesEnvFile(home)).toBe("/home/dev/.cww/services.env");
    expect(projectServicesEnvFile("api", home)).toBe("/home/dev/.cww/services/api.env");
    expect(workspaceServicesEnvFile("api", "sandbox", home)).toBe(
      "/home/dev/.cww/services/api/sandbox.env",
    );
  });

  test("names are sanitized like container and task names are", () => {
    // A user types 'MyProject' and 'Feature/Auth'; the file has one spelling.
    expect(projectServicesEnvFile("MyProject", home)).toBe("/home/dev/.cww/services/myproject.env");
    expect(workspaceServicesEnvFile("MyProject", "Feature/Auth", home)).toBe(
      "/home/dev/.cww/services/myproject/feature-auth.env",
    );
  });

  test("servicesEnvFiles orders layers least- to most-specific", () => {
    // The order is the precedence rule: 'cww create' renders it straight into
    // the compose env_file list, where a later entry wins.
    expect(servicesEnvFiles("api", "sandbox", home)).toEqual([
      "/home/dev/.cww/services.env",
      "/home/dev/.cww/services/api.env",
      "/home/dev/.cww/services/api/sandbox.env",
    ]);
  });

  test("layers are distinct across projects and across workspaces", () => {
    const a = servicesEnvFiles("api", "sandbox", home);
    const b = servicesEnvFiles("api", "review", home);
    const c = servicesEnvFiles("web", "sandbox", home);
    expect(a[1]).toBe(b[1]!); // same project, shared project layer
    expect(a[2]).not.toBe(b[2]!); // different workspace, own layer
    expect(a[1]).not.toBe(c[1]!); // different project, own layer
    expect(a[2]).not.toBe(c[2]!);
  });

  test("a project's file and its workspace directory can coexist on disk", () => {
    // Why the workspace layer nests instead of being a flat
    // <project>-<workspace>.env: a project literally named 'api-sandbox' would
    // otherwise collide with workspace 'sandbox' of project 'api'.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-services-env-"));
    try {
      const projectFile = projectServicesEnvFile("api", dir);
      const workspaceFile = workspaceServicesEnvFile("api", "sandbox", dir);
      fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
      fs.writeFileSync(projectFile, "K=project\n");
      fs.writeFileSync(workspaceFile, "K=workspace\n");
      expect(fs.readFileSync(projectFile, "utf8")).toBe("K=project\n");
      expect(fs.readFileSync(workspaceFile, "utf8")).toBe("K=workspace\n");

      // The colliding flat name would have been the same string.
      expect(workspaceServicesEnvFile("api-sandbox", "sandbox", dir)).not.toBe(workspaceFile);
      expect(projectServicesEnvFile("api-sandbox", dir)).not.toBe(projectFile);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
