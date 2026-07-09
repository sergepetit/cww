import { describe, expect, test } from "bun:test";
import {
  formatPortsDisplay,
  parsePortMap,
  publishedPortsCsv,
} from "../src/lib/docker";

describe("parsePortMap", () => {
  test("parses docker {{.Ports}} fields into container->host bindings", () => {
    expect(parsePortMap(["0.0.0.0:49153->3000/tcp"])).toEqual([{ container: 3000, host: 49153 }]);
  });

  test("drops IPv6 (:::) rows", () => {
    expect(parsePortMap(["0.0.0.0:49153->3000/tcp, :::49154->3000/tcp"])).toEqual([
      { container: 3000, host: 49153 },
    ]);
  });

  test("merges multiple containers' fields, deduplicated and sorted", () => {
    const fields = [
      "0.0.0.0:49155->5432/tcp",
      "0.0.0.0:49153->3000/tcp, 0.0.0.0:49153->3000/tcp",
      "",
    ];
    expect(parsePortMap(fields)).toEqual([
      { container: 3000, host: 49153 },
      { container: 5432, host: 49155 },
    ]);
  });

  test("handles udp bindings and ignores unpublished ports", () => {
    expect(parsePortMap(["0.0.0.0:49156->53/udp, 8080/tcp"])).toEqual([
      { container: 53, host: 49156 },
    ]);
  });
});

describe("port rendering", () => {
  const map = [
    { container: 3000, host: 49153 },
    { container: 5432, host: 49155 },
  ];

  test("formatPortsDisplay renders container->host pairs", () => {
    expect(formatPortsDisplay(map)).toBe("3000->49153,5432->49155");
    expect(formatPortsDisplay([])).toBe("");
  });

  test("publishedPortsCsv renders sorted unique host ports", () => {
    expect(publishedPortsCsv(map)).toBe("49153,49155");
    expect(publishedPortsCsv([])).toBe("");
  });
});
