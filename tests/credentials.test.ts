import { describe, expect, test } from "bun:test";
import {
  formatCredentials,
  matchCredential,
  parseCredentials,
  upsertCredential,
  type Credential,
} from "../src/lib/credentials";

describe("parseCredentials", () => {
  test("parses git-credentials lines, skipping comments, blanks, and junk", () => {
    const text = [
      "# per-repo entry",
      "https://dev:tok1@forgejo.example/dev/api.git",
      "",
      "https://x-access-token:tok2@github.com/org/repo",
      "not a url",
      "https://no-password@host.example/x", // no token -> skipped
    ].join("\n");
    const entries = parseCredentials(text);
    expect(entries).toEqual([
      { user: "dev", token: "tok1", url: "https://forgejo.example/dev/api.git" },
      { user: "x-access-token", token: "tok2", url: "https://github.com/org/repo" },
    ]);
  });

  test("decodes percent-encoded userinfo and keeps non-443 ports", () => {
    const [e] = parseCredentials("http://a%40b.c:p%23w@forgejo.example:3000/org/repo");
    expect(e).toEqual({
      user: "a@b.c",
      token: "p#w",
      url: "http://forgejo.example:3000/org/repo",
    });
  });

  test("round-trips through formatCredentials", () => {
    const entries: Credential[] = [
      { user: "a@b", token: "s#cr:et", url: "https://forgejo.example:3000/org/repo" },
      { user: "u", token: "t", url: "https://github.com" },
    ];
    expect(parseCredentials(formatCredentials(entries))).toEqual(entries);
  });
});

describe("matchCredential", () => {
  const entries = parseCredentials(
    [
      "https://host-wide:t1@forgejo.example",
      "https://per-repo:t2@forgejo.example/dev/api",
      "https://other:t3@github.com/org/repo",
    ].join("\n"),
  );

  test("per-repo entry beats host-wide, .git and trailing slash ignored", () => {
    expect(matchCredential(entries, "https://forgejo.example/dev/api.git")?.user).toBe(
      "per-repo",
    );
    expect(matchCredential(entries, "https://forgejo.example/dev/api/")?.user).toBe(
      "per-repo",
    );
  });

  test("host-wide entry covers other repos on the same origin", () => {
    expect(matchCredential(entries, "https://forgejo.example/other/repo.git")?.user).toBe(
      "host-wide",
    );
  });

  test("matches on path boundaries, not string prefixes", () => {
    // .../api must not match .../api-v2
    expect(matchCredential(entries, "https://forgejo.example/dev/api-v2.git")?.user).toBe(
      "host-wide",
    );
  });

  test("origin must match exactly: scheme, host, and port", () => {
    expect(matchCredential(entries, "http://forgejo.example/dev/api")).toBeNull();
    expect(matchCredential(entries, "https://forgejo.example:3000/dev/api")).toBeNull();
    expect(matchCredential(entries, "https://forgejo.example.evil.com/dev/api")).toBeNull();
  });

  test("null for no match or unparseable url", () => {
    expect(matchCredential(entries, "https://gitlab.com/x/y")).toBeNull();
    expect(matchCredential(entries, "not a url")).toBeNull();
  });
});

describe("upsertCredential", () => {
  test("replaces the entry for the same repo (normalized), appends otherwise", () => {
    const start: Credential[] = [
      { user: "old", token: "t0", url: "https://forgejo.example/dev/api.git" },
    ];
    const replaced = upsertCredential(start, {
      user: "new",
      token: "t1",
      url: "https://forgejo.example/dev/api", // same repo, no .git
    });
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.user).toBe("new");

    const appended = upsertCredential(replaced, {
      user: "u2",
      token: "t2",
      url: "https://github.com/org/repo",
    });
    expect(appended).toHaveLength(2);
  });
});
