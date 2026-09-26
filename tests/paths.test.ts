import { describe, expect, test } from "bun:test";
import { isDrivePath, isUnderHostPath, sameHostPath } from "../src/lib/paths";

describe("isDrivePath", () => {
  test("recognises drive paths on Windows only", () => {
    expect(isDrivePath("C:\\Users\\x", "win32")).toBe(true);
    expect(isDrivePath("d:/repo", "win32")).toBe(true);
    expect(isDrivePath("ws:/tmp", "win32")).toBe(false);
    expect(isDrivePath("C:", "win32")).toBe(false);
    expect(isDrivePath("C:\\Users\\x", "darwin")).toBe(false);
  });
});

describe("sameHostPath", () => {
  test("Windows: slash direction and case don't matter", () => {
    // git prints 'C:/Users/x/repo'; node's cwd is 'C:\Users\x\repo'.
    expect(sameHostPath("C:/Users/x/repo", "c:\\users\\X\\repo\\", "win32")).toBe(true);
    expect(sameHostPath("C:/Users/x/repo", "C:/Users/x/other", "win32")).toBe(false);
  });

  test("POSIX: case matters, trailing slash doesn't", () => {
    expect(sameHostPath("/home/x/repo/", "/home/x/repo", "linux")).toBe(true);
    expect(sameHostPath("/home/x/Repo", "/home/x/repo", "linux")).toBe(false);
  });
});

describe("isUnderHostPath", () => {
  test("matches the dir itself and what is below it, not siblings sharing a prefix", () => {
    expect(isUnderHostPath("/home/x/.cww", "/home/x", "linux")).toBe(true);
    expect(isUnderHostPath("/home/x", "/home/x", "linux")).toBe(true);
    expect(isUnderHostPath("/home/xy", "/home/x", "linux")).toBe(false);
    expect(isUnderHostPath("c:\\users\\x\\.cww", "C:/Users/X", "win32")).toBe(true);
    expect(isUnderHostPath("C:\\Users\\xy", "C:\\Users\\x", "win32")).toBe(false);
  });
});
