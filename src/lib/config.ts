// Behavior toggles read from the environment (~/.cww/env and <repo>/.cww/env
// are sourced by the caller before the CLI runs, so they land in process.env).

// Whether new workspaces get the built-in headful browser (Chrome + noVNC,
// drivable by the agent via chrome-devtools-mcp). Default ON; set
// CWW_BROWSER=off (or 0/false/no) in ~/.cww/env or <repo>/.cww/env to skip it.
// Values are matched case-sensitively, like the bash lib did.
export function browserEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["off", "0", "false", "no"].includes(env.CWW_BROWSER ?? "on");
}
