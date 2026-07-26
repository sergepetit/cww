import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeFileArgs,
  imageAgeHours,
  imageIsStale,
  parseContainerInspect,
  parseImageInspect,
  STALE_IMAGE_DAYS,
} from "../src/lib/docker";

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

describe("imageAgeHours", () => {
  const NOW = Date.parse("2026-07-26T12:00:00Z");

  test("rounds to whole hours against docker's RFC3339 stamps", () => {
    expect(imageAgeHours("2026-07-26T09:00:00.123456789Z", NOW)).toBe(3);
    expect(imageAgeHours("2026-06-26T12:00:00Z", NOW)).toBe(30 * 24);
  });

  test("null for a missing or unparseable stamp, never negative", () => {
    expect(imageAgeHours(null, NOW)).toBeNull();
    expect(imageAgeHours(undefined, NOW)).toBeNull();
    expect(imageAgeHours("not a date", NOW)).toBeNull();
    // A host clock behind the daemon's must not read as a future image.
    expect(imageAgeHours("2026-07-26T13:00:00Z", NOW)).toBe(0);
  });

  test("staleness turns over exactly at the threshold", () => {
    expect(imageIsStale(STALE_IMAGE_DAYS * 24 - 1)).toBe(false);
    expect(imageIsStale(STALE_IMAGE_DAYS * 24)).toBe(true);
    expect(imageIsStale(null)).toBe(false);
  });
});

describe("parseContainerInspect", () => {
  test("keys by name without docker's leading slash, and reads both image fields", () => {
    const map = parseContainerInspect(
      [
        "/cww-smoke-one|true|sha256:aaa|coder-workspace-workflow:claude",
        "/cww-smoke-two|false|sha256:bbb|cww-project-todo:claude",
        "",
      ].join("\n"),
    );
    expect(map.get("cww-smoke-one")).toEqual({
      running: true,
      imageId: "sha256:aaa",
      imageRef: "coder-workspace-workflow:claude",
    });
    expect(map.get("cww-smoke-two")?.running).toBe(false);
    // Containers docker couldn't find never reach stdout — they're just absent.
    expect(map.has("cww-smoke-gone")).toBe(false);
  });
});

describe("parseImageInspect", () => {
  test("indexes each image by id and by every repo tag", () => {
    const map = parseImageInspect(
      [
        "sha256:aaa|2026-07-22T09:39:47.871236799Z|[coder-workspace-workflow:claude cww-base:latest]",
        "sha256:bbb|2026-07-01T08:00:00.000000000Z|[]",
      ].join("\n"),
    );
    expect(map.get("sha256:aaa")).toEqual({
      id: "sha256:aaa",
      created: "2026-07-22T09:39:47.871236799Z",
    });
    expect(map.get("coder-workspace-workflow:claude")?.id).toBe("sha256:aaa");
    expect(map.get("cww-base:latest")?.id).toBe("sha256:aaa");
    // An untagged image (its tag has moved on) is reachable by id only.
    expect(map.get("sha256:bbb")?.created).toBe("2026-07-01T08:00:00.000000000Z");
    expect(map.has("<none>:<none>")).toBe(false);
  });
});
