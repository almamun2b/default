import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

export class LockedError extends Error {}

const heldLocks = new Set<string>();
let exitHookInstalled = false;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The PID a lock file names, 0 if the file is missing or unreadable. */
export function lockPid(lockFile: string): number {
  try {
    return Number(fs.readFileSync(lockFile, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

/** Takes the lock or throws if another live run holds it. Returns the release function. */
export function acquireLock(lockFile: string): () => void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      const pid = lockPid(lockFile);
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw new LockedError(`${path.basename(lockFile, '.lock')} is in use by another run (pid ${pid}); wait for it or kill it first`);
      }
      log.warn({ lockFile, pid }, `taking over ${path.basename(lockFile)}: the run that held it (pid ${pid}) is gone`);
      fs.rmSync(lockFile, { force: true });
    }
  }
  heldLocks.add(lockFile);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // process.exit (also used by the signal handlers) runs 'exit' listeners synchronously
    process.on('exit', () => { for (const l of heldLocks) fs.rmSync(l, { force: true }); });
  }
  return () => {
    heldLocks.delete(lockFile);
    fs.rmSync(lockFile, { force: true });
  };
}

/**
 * Replaces a file via a temp file and rename, so a crash never leaves it truncated. Outputs hold personal data,
 * so a new file is readable by its owner only (an existing file keeps its mode).
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = file + '.tmp';
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode); // the umask may have narrowed it
  fs.renameSync(tmp, file);
}
