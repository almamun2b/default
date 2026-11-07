import fs from 'node:fs';
import path from 'node:path';
import { dbFiles, OUT_DIR, type DbFiles } from '../paths.js';
import { acquireLock } from './lock.js';
import { PagesRepo, type PagesView, type Provenance } from './pages-repo.js';
import { RunsRepo } from './runs-repo.js';
import { SitesRepo, type ListRef } from './sites-repo.js';

/** Schema version of the whole results/db/ folder, kept in manifest.json. */
export const DB_SCHEMA = 2;

export interface Manifest {
  schema: number;
  createdAt: string;
  /** Imports from the old per-category layout, by source file: see migrate.ts. */
  migrations?: Record<string, unknown>;
}

export function readManifest(files: DbFiles): Manifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(files.manifest, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

export function writeManifest(files: DbFiles, m: Manifest): void {
  const tmp = files.manifest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, files.manifest);
}

export interface BeginList {
  cat: string;
  list: string;
  run: string;
  /** What the run is doing with the list: 'scrape', 'retry failed + capped', 'new-only', 'summary'... */
  mode: string;
  sites: number;
  /** The list already has an output CSV. */
  outputExists: boolean;
  /** A retry or --new-only run: builds on the list's current results instead of starting a new generation. */
  keep: boolean;
}

/**
 * The database in results/db/: pages, site results and run history behind three small repositories (so a SQLite
 * implementation can replace the JSON-lines files later without touching the callers). Site results and history
 * open at once (they read only a snapshot and a tail); the page store is opened on first use, takes the
 * database's one page-writer lock and stays locked until `close()`.
 */
export class Db {
  readonly files: DbFiles;
  readonly sites: SitesRepo;
  readonly runs: RunsRepo;
  private pagesRepo?: PagesRepo;
  private releasePages?: () => void;
  private readonly listLocks = new Map<string, () => void>();

  /** `readOnly` (for --dry-run) creates and writes nothing; it can't lock or store pages. */
  constructor(readonly outDir = OUT_DIR, private readonly opts: { readOnly?: boolean } = {}) {
    this.files = dbFiles(outDir);
    if (!opts.readOnly) {
      fs.mkdirSync(this.files.locksDir, { recursive: true, mode: 0o700 });
      if (!readManifest(this.files)) writeManifest(this.files, { schema: DB_SCHEMA, createdAt: new Date().toISOString() });
    }
    this.sites = new SitesRepo({ data: this.files.sites, index: this.files.sitesIndex }, { readOnly: opts.readOnly });
    this.runs = new RunsRepo(this.files.runs);
  }

  /**
   * The page store. Takes the pages lock on first use because two writers appending to one file would corrupt its
   * index; throws LockedError if another live run holds it. The lock is held until close().
   */
  get pages(): PagesRepo {
    if (this.opts.readOnly) throw new Error('the database is open read-only');
    if (!this.pagesRepo) {
      this.releasePages = acquireLock(path.join(this.files.locksDir, 'pages.lock'));
      try {
        this.pagesRepo = new PagesRepo({ data: this.files.pages, index: this.files.pagesIndex });
      } catch (err) {
        this.releasePages();
        this.releasePages = undefined;
        throw err;
      }
    }
    return this.pagesRepo;
  }

  /** The page store as one crawl sees it: what it stores is credited to `who`. */
  pagesFor(who: Provenance): PagesView {
    return this.pages.view(who);
  }

  /** The file holding the PID of the run working on a list. */
  listLockFile(cat: string, list: string): string {
    return path.join(this.files.locksDir, `${`${cat}.${list}`.replace(/[\\/]/g, '_')}.lock`);
  }

  /** The lock on one list, so two runs never process it at once. Throws LockedError if a live run holds it. Released by close(). */
  lockList(cat: string, list: string): () => void {
    if (this.opts.readOnly) throw new Error('the database is open read-only');
    const key = `${cat}.${list}`;
    if (this.listLocks.has(key)) return this.listLocks.get(key)!;
    const release = acquireLock(this.listLockFile(cat, list));
    const once = () => { release(); this.listLocks.delete(key); };
    this.listLocks.set(key, once);
    return once;
  }

  /** The generation of a list's current results: the newest one that has rows or was started. 0 if the list was never scraped. */
  generation(cat: string, list: string): number {
    return Math.max(this.runs.startedGeneration(cat, list), this.sites.generation(cat, list));
  }

  /**
   * Starts (or resumes) processing a list, and records it in the history. An interrupted list resumes in its own
   * generation. Otherwise a list that already has an output opens the next generation for a plain re-scrape
   * (the old results stay in the file, ignored), and a retry or --new-only run keeps the current one.
   */
  beginList(o: BeginList): ListRef & { resumed: boolean; fresh: boolean } {
    const interrupted = this.runs.interrupted(o.cat, o.list);
    const current = this.generation(o.cat, o.list);
    const resumed = !!interrupted;
    const fresh = !resumed && o.outputExists && !o.keep && current > 0;
    const generation = resumed ? Math.max(interrupted!.generation, current) : fresh ? current + 1 : Math.max(current, 1);
    this.runs.append({ type: 'list.start', run: o.run, cat: o.cat, list: o.list, generation, mode: o.mode, sites: o.sites, resumed, fresh });
    return { cat: o.cat, list: o.list, generation, run: o.run, resumed, fresh };
  }

  close(): void {
    this.pagesRepo?.close();
    this.releasePages?.();
    this.pagesRepo = undefined;
    this.releasePages = undefined;
    for (const release of [...this.listLocks.values()]) release();
    this.sites.close();
    this.runs.close();
  }
}

export function openDb(outDir = OUT_DIR): Db {
  return new Db(outDir);
}
