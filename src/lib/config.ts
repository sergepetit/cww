// Behavior toggles read from the environment (the caller loads ~/.cww/env
// into process.env, and applies any per-project override from
// ~/.cww/config.json the same way, before consulting these).

// Whether new workspaces get the built-in headful browser (Chrome + noVNC,
// drivable by the agent via chrome-devtools-mcp). Default ON; set
// CWW_BROWSER=off (or 0/false/no) in ~/.cww/env — or "browser": "off" in the
// project's ~/.cww/config.json entry — to skip it. Values are matched
// case-sensitively, like the bash lib did.
export function browserEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["off", "0", "false", "no"].includes(env.CWW_BROWSER ?? "on");
}
