import fs from 'node:fs';
import path from 'node:path';
import { dbFiles, OUT_DIR } from '../paths.js';
import { DB_SCHEMA, readManifest, writeManifest } from './open.js';
import { openAppend, scanLines, writeAll } from './jsonl.js';
import { acquireLock } from './lock.js';
import { PagesRepo, type UpgradeCounts } from './pages-repo.js';
import { runEventFields } from './runs-repo.js';
import { RUN_EVENT_VERSION } from './runs-repo.js';
import { SITE_ROW_VERSION, siteRowFields } from './sites-repo.js';

/**
 * `npm run db:upgrade`: rewrites the three data files of results/db/ in the current field names (version 2) and
 * drops what is dead weight. Each file is written beside the original and swapped in with a rename only when it is
 * complete, so a failure leaves the database as it was.
 *
 * - pages.jsonl: `v,k,m,a,d` become `version,pageKey,mode,fetchedAt,page`; a record that a newer copy of the same
 *   page replaced (a changed page that was fetched again) is dropped, so the file keeps one record per page.
 * - sites.jsonl: `v,t,g,a,r` become `version,type,generation,writtenAt,result`. Every row stays (older
 *   generations are history).
 * - run-history.jsonl: `v,t,a,g` become `version,type,at,generation`.
 * - Lines cut off by a crash (they never parsed) are dropped.
 *
 * A file that is already current is left alone. The indexes (pages.idx, sites.idx) point into the old files, so they
 * are deleted and the next run rebuilds them from the new ones (slow once). Needs free disk space about the size of
 * the largest file, and no scrape running (it takes the same lock a scrape does).
 */
export interface UpgradeOptions {
  outDir?: string;
  /** Count only; write nothing. */
  dryRun?: boolean;
}

export interface FileReport {
  file: string;
  before: number; // bytes
  after: number; // bytes (the size it would have, for a dry run: unknown, 0)
  lines: number;
  converted: number; // lines written under the new names
  dropped: number; // lines left out (superseded pages, damaged lines)
  upgraded: boolean; // the file was replaced
}

export function upgradeDb(opts: UpgradeOptions = {}): FileReport[] {
  const f = dbFiles(opts.outDir ?? OUT_DIR);
  const reports: FileReport[] = [];
  if (!fs.existsSync(f.dir)) return reports;
  fs.mkdirSync(f.locksDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(f.locksDir, 'pages.lock'));
  try {
    reports.push(upgradePages(f.pages, f.pagesIndex, opts.dryRun));
    reports.push(upgradeLines(f.sites, [f.sitesIndex], opts.dryRun, siteLine));
    reports.push(upgradeLines(f.runs, [], opts.dryRun, runLine));
    if (!opts.dryRun && reports.every((r) => r.upgraded || !r.converted)) {
      const m = readManifest(f);
      if (m && m.schema < DB_SCHEMA) writeManifest(f, { ...m, schema: DB_SCHEMA });
    }
  } finally {
    release();
  }
  return reports;
}

const sizeOf = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

/** Moves `tmp` over `file`, and removes the derived indexes that described the old file. */
function swapIn(file: string, tmp: string, indexes: string[]): void {
  fs.renameSync(tmp, file);
  for (const ix of indexes) fs.rmSync(ix, { force: true });
}

function upgradePages(file: string, index: string, dryRun?: boolean): FileReport {
  const report: FileReport = { file, before: sizeOf(file), after: 0, lines: 0, converted: 0, dropped: 0, upgraded: false };
  if (!report.before) return report;
  const tmp = `${file}.upgrade`;
  const repo = new PagesRepo({ data: file, index });
  let n: UpgradeCounts;
  try {
    n = repo.upgradeTo(dryRun ? undefined : tmp);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    repo.close();
  }
  Object.assign(report, { lines: n.lines, converted: n.converted, dropped: n.superseded + n.damaged });
  if (dryRun) return report;
  if (!n.converted && !n.superseded && !n.damaged) {
    fs.rmSync(tmp, { force: true });
    return report;
  }
  report.after = sizeOf(tmp);
  swapIn(file, tmp, [index]);
  report.upgraded = true;
  return report;
}

/** Converts one line of a file to the current names; undefined drops it. */
type Convert = (text: string) => { text: string; changed: boolean } | undefined;

function upgradeLines(file: string, indexes: string[], dryRun: boolean | undefined, convert: Convert): FileReport {
  const report: FileReport = { file, before: sizeOf(file), after: 0, lines: 0, converted: 0, dropped: 0, upgraded: false };
  if (!report.before) return report;
  const tmp = `${file}.upgrade`;
  const fd = dryRun ? null : openAppend(tmp);
  if (fd !== null) fs.ftruncateSync(fd, 0);
  let out: string[] = [], bytes = 0;
  const flush = () => {
    if (fd !== null && out.length) writeAll(fd, Buffer.from(out.join('')));
    out = [];
    bytes = 0;
  };
  try {
    const end = scanLines(file, 0, (data, s, e) => {
      report.lines++;
      const text = data.toString('utf8', s, e);
      const r = text.trim() ? convert(text) : undefined;
      if (!r) { report.dropped++; return; }
      if (r.changed) report.converted++;
      out.push(r.text, '\n');
      bytes += r.text.length + 1;
      if (bytes >= 4 << 20) flush();
    });
    if (end < report.before) report.dropped++; // an unterminated tail: a record cut off by a crash
    flush();
    if (fd !== null) fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (fd !== null) fs.closeSync(fd);
  if (dryRun || (!report.converted && !report.dropped)) {
    fs.rmSync(tmp, { force: true });
    return report;
  }
  report.after = sizeOf(tmp);
  swapIn(file, tmp, indexes);
  report.upgraded = true;
  return report;
}

const SITE_BODIES = [',"result":', ',"r":'];

/** A sites.jsonl line under the current names; the result (large) is copied as text, never parsed. */
const siteLine: Convert = (text) => {
  let cut = -1, marker = '';
  for (const m of SITE_BODIES) {
    const i = text.indexOf(m);
    if (i >= 0 && (cut < 0 || i < cut)) { cut = i; marker = m; }
  }
  try {
    const head = JSON.parse(cut >= 0 ? text.slice(0, cut) + '}' : text) as Record<string, unknown>;
    if (head.version === SITE_ROW_VERSION) return { text, changed: false };
    if (typeof head.site !== 'string') return undefined;
    const fields = JSON.stringify({ ...siteRowFields(head), version: SITE_ROW_VERSION });
    return { text: cut >= 0 ? `${fields.slice(0, -1)},"result":${text.slice(cut + marker.length, -1)}}` : fields, changed: true };
  } catch {
    return undefined;
  }
};

const runLine: Convert = (text) => {
  try {
    const ev = JSON.parse(text) as Record<string, unknown>;
    if (ev.version === RUN_EVENT_VERSION) return { text, changed: false };
    if (typeof ev.v !== 'number') return undefined;
    return { text: JSON.stringify({ ...runEventFields(ev), version: RUN_EVENT_VERSION }), changed: true };
  } catch {
    return undefined;
  }
};

export function describeReport(r: FileReport): string {
  const name = path.basename(r.file);
  if (!r.before) return `${name}: not there`;
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  const what = `${r.lines} lines, ${r.converted} to rename, ${r.dropped} to drop`;
  if (r.upgraded) return `${name}: ${what}; ${mb(r.before)} -> ${mb(r.after)}`;
  return r.converted || r.dropped ? `${name}: ${what} (dry run, nothing written)` : `${name}: already current (${r.lines} lines)`;
}

