// Console output and interactive prompts. Colors and message prefixes carry
// over from the retired bash CLI (scripts/lib/common.sh) so output stayed
// identical across the migration.

export const RED = "\x1b[0;31m";
export const GREEN = "\x1b[0;32m";
export const YELLOW = "\x1b[1;33m";
export const BLUE = "\x1b[0;34m";
export const NC = "\x1b[0m";

export function info(msg: string): void {
  console.log(`${BLUE}[INFO]${NC} ${msg}`);
}

export function success(msg: string): void {
  console.log(`${GREEN}[OK]${NC} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}[WARN]${NC} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${RED}[ERROR]${NC} ${msg}`);
}

export function die(msg: string): never {
  error(msg);
  process.exit(1);
}

// Yes/no prompt; empty answer takes the default. Uses Bun's global prompt().
export function confirm(question = "Continue?", def: "y" | "n" = "y"): boolean {
  const hint = def === "y" ? "[Y/n]" : "[y/N]";
  const answer = (prompt(`${question} ${hint}:`) ?? "").trim() || def;
  return /^[yY]/.test(answer);
}

// Hidden-input prompt for secrets: terminal echo is disabled around Bun's
// prompt() so the value stays out of the scrollback. Without a TTY (piped
// stdin) stty would fail, so input is read normally there.
export function promptSecret(label: string): string {
  const tty = process.stdin.isTTY === true;
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    return (prompt(`${label}:`) ?? "").trim();
  } finally {
    if (tty) {
      Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
      console.log(""); // the Enter keystroke was swallowed by -echo
    }
  }
}

// Numbered-menu prompt. Returns the 1-based choice, or 0 on invalid input.
export function promptChoice(question: string, options: string[]): number {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const raw = (prompt(`Choice [1-${options.length}]:`) ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return 0;
  const choice = Number(raw);
  return choice >= 1 && choice <= options.length ? choice : 0;
}
