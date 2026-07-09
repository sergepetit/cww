// Filesystem path resolution helpers.

import fs from "node:fs";
import path from "node:path";
import { die } from "./ui";

// Resolve a project path from an argument (absolute or cwd-relative) or the
// current directory. Dies when the directory doesn't exist.
export function resolveProjectPath(arg?: string): string {
  const resolved = !arg || arg === "." ? process.cwd() : path.resolve(process.cwd(), arg);
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    // fall through to die below
  }
  if (!isDir) die(`Directory does not exist: ${arg}`);
  return resolved;
}
