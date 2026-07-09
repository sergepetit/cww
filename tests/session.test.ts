import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSession, writeSession, type Session } from "../src/lib/session";

describe("session round-trip", () => {
  test("writeSession then readSession returns the same data", () => {
    const taskDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-")), "proj-ws");
    const session: Session = {
      project: "proj",
      workspace: "ws",
      branch: "main",
      agent: "claude",
      container: "cww-proj-ws",
      created: "2026-07-09T10:00:00Z",
      mainRepo: "/home/user/proj",
    };
    try {
      writeSession(taskDir, session);
      expect(readSession(taskDir)).toEqual(session);
    } finally {
      fs.rmSync(path.dirname(taskDir), { recursive: true, force: true });
    }
  });

  test("readSession returns {} when session.json is missing", () => {
    expect(readSession("/nonexistent/task/dir")).toEqual({});
  });

  test("readSession throws on a corrupt session.json", () => {
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
    try {
      fs.writeFileSync(path.join(taskDir, "session.json"), "{not json");
      expect(() => readSession(taskDir)).toThrow();
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });
});
