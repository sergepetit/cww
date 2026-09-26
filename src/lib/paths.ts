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

// Host-platform helpers. The platform is a parameter (defaulting to the real
// one) so the Windows rules can be unit-tested on any host.

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

// 'C:\x' or 'C:/x' — a Windows drive path, which must never be mistaken for a
// '<workspace>:<path>' argument.
export function isDrivePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return isWindows(platform) && /^[A-Za-z]:[\\/]/.test(p);
}

// Canonical form of a host path for comparison. Windows paths come back in
// several spellings for the same directory (git prints 'C:/Users/x', node
// 'C:\Users\x', drive letters in either case), and NTFS is case-insensitive.
export function hostPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (!isWindows(platform)) return path.posix.resolve(p);
  return path.win32.resolve(p).toLowerCase();
}

export function sameHostPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return hostPathKey(a, platform) === hostPathKey(b, platform);
}

// Whether `p` lies at or below `dir`, by the same comparison rules.
export function isUnderHostPath(p: string, dir: string, platform: NodeJS.Platform = process.platform): boolean {
  const kp = hostPathKey(p, platform);
  const kd = hostPathKey(dir, platform);
  const sep = isWindows(platform) ? "\\" : "/";
  return kp === kd || kp.startsWith(kd.endsWith(sep) ? kd : kd + sep);
}
