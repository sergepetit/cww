import { describe, expect, test } from "bun:test";
import { buildTunnelSpec } from "../src/commands/tunnel-command";

describe("buildTunnelSpec", () => {
  test("forwards each binding at its container port", () => {
    const spec = buildTunnelSpec([
      { container: 3000, host: 49153 },
      { container: 7900, host: 49155 },
    ]);
    expect(spec.forwards).toBe(" -L 3000:localhost:49153 -L 7900:localhost:49155");
    expect(spec.locals).toBe("localhost:3000, localhost:7900");
    expect(spec.remapped).toBe("");
  });

  test("remaps privileged container ports by +8000", () => {
    const spec = buildTunnelSpec([
      { container: 80, host: 32768 },
      { container: 443, host: 32769 },
      { container: 3000, host: 32770 },
    ]);
    expect(spec.forwards).toBe(
      " -L 8080:localhost:32768 -L 8443:localhost:32769 -L 3000:localhost:32770",
    );
    expect(spec.locals).toBe("localhost:8080, localhost:8443, localhost:3000");
    expect(spec.remapped).toBe("80 -> 8080, 443 -> 8443");
  });

  test("empty map yields empty spec", () => {
    expect(buildTunnelSpec([])).toEqual({ forwards: "", locals: "", remapped: "" });
  });
});
