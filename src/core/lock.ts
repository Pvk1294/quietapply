import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/**
 * A run lock so two runs never drive the same browser profile at once. The lock file holds the owner's pid;
 * a lock left by a process that no longer exists is taken over.
 */
export function acquireLock(path: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!isStale(path)) return null;
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isStale(path: string): boolean {
  if (!existsSync(path)) return true;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
