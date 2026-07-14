import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeFileArgs } from "../src/lib/docker";

describe("composeFileArgs", () => {
  test("layers only the optional override files that exist", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    fs.writeFileSync(path.join(taskDir, "docker-compose.yml"), "services: {}\n");
    expect(composeFileArgs(taskDir)).toEqual(["-f", path.join(taskDir, "docker-compose.yml")]);

    fs.writeFileSync(path.join(taskDir, "docker-compose.agent.yml"), "services: {}\n");
    expect(composeFileArgs(taskDir)).toEqual([
      "-f",
      path.join(taskDir, "docker-compose.yml"),
      "-f",
      path.join(taskDir, "docker-compose.agent.yml"),
    ]);
  });
});
