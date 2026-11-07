import fs from 'node:fs';
import path from 'node:path';
import type { SiteResult } from '../crawler.js';
import { log } from '../logger.js';
import { EMAILS_NAME, OUT_DIR } from '../paths.js';
import { scanLines } from './jsonl.js';
import { lockPid, pidAlive } from './lock.js';
import { DB_SCHEMA, readManifest, writeManifest, type Db } from './open.js';
import { goneLine, pageLine, type Mode } from './pages-repo.js';

/**
 * Imports the old per-category layout into results/db/ and results/emails/. The old files are only read, never
 * changed or deleted. What was in each category folder:
 *
 *   .cache/.pages                 -> pages.jsonl (one copy of each page across all categories, the newest)
 *   .cache/<list>.jsonl           -> sites.jsonl, generation k+1 (k = number of rotated caches of the list)
 *   .cache/<list>.<stamp>.jsonl   -> sites.jsonl, an earlier generation (by stamp)
 *   .cache/<list>.inprogress      -> a list.start with no list.end: the next run resumes the list
 *   logs/<list>.log               -> run-history.jsonl (legacy list.end / filter / note events with the original text)
 *   emails/**.csv                 -> results/emails/<category>/**.csv (copied)
 *
 * Each source is recorded in manifest.json when done, so a run that is interrupted or repeated imports what is
 * left and never twice. Pages are also protected by the store itself (a page is skipped if it already has a copy
 * at least as new), so even a repeated page import changes nothing.
 */

export interface LegacyCategory {
  cat: string | null; // null: the cross-category results/unique + results/logs
  dir: string;
}

export interface Source {
  key: string; // ledger key, e.g. `pizza-au/.cache/.pages`
  kind: 'pages' | 'cache' | 'marker' | 'log' | 'csv';
  cat: string | null;
  file: string;
  size: number;
  /** For caches: the list and its generation (assigned across the list's files). */
  list?: string;
  g?: number;
  /** For csvs: where the copy goes. */
  dest?: string;
}

export interface MigrationReport {
  sources: number;
  done: number;
  pages: { read: number; imported: number; skipped: number; bad: number };
  rows: number;
  events: number;
  interrupted: string[];
  csvs: { copied: number; kept: number };
  dryRun: boolean;
}

interface LedgerEntry {
  at: string;
  size: number;
  [stat: string]: unknown;
}

const LEGACY_SKIP = new Set(['db', EMAILS_NAME]);
const STAMPED = /^(.+)\.(\d{8}-\d{6})\.jsonl$/;

/** Category folders of the old layout under results/. */
export function findLegacy(outDir = OUT_DIR): LegacyCategory[] {
  if (!fs.existsSync(outDir)) return [];
  const out: LegacyCategory[] = [];
  for (const e of fs.readdirSync(outDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || LEGACY_SKIP.has(e.name)) continue;
    const dir = path.join(outDir, e.name);
    if (e.name === 'unique' || e.name === 'logs') {
      if (fs.readdirSync(dir).some((f) => f.endsWith('.csv') || f.endsWith('.log'))) out.push({ cat: null, dir });
      continue;
    }
    if (['.cache', 'emails', 'logs'].some((sub) => fs.existsSync(path.join(dir, sub)))) out.push({ cat: e.name, dir });
  }
  return out;
}

const size = (f: string) => fs.statSync(f).size;

/** Everything the old layout holds that can be imported, with the generation of each list's cache files worked out. */
export function listSources(outDir = OUT_DIR): Source[] {
  const sources: Source[] = [];
  for (const { cat, dir } of findLegacy(outDir)) {
    if (cat === null) { // results/unique/*.csv and results/logs/unique.*.log
      const name = path.basename(dir);
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (name === 'unique' && f.endsWith('.csv')) sources.push({ key: `(all)/unique/${f}`, kind: 'csv', cat, file: full, size: size(full), dest: path.join(outDir, EMAILS_NAME, 'unique', f) });
        if (name === 'logs' && f.endsWith('.log')) sources.push({ key: `(all)/logs/${f}`, kind: 'log', cat, file: full, size: size(full) });
      }
      continue;
    }
    const cacheDir = path.join(dir, '.cache');
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      const pages = path.join(cacheDir, '.pages');
      if (fs.existsSync(pages)) sources.push({ key: `${cat}/.cache/.pages`, kind: 'pages', cat, file: pages, size: size(pages) });
      // cache files per list: rotated ones (by stamp) are earlier generations, the live one the latest
      const lists = new Map<string, { rotated: { stamp: string; file: string }[]; live?: string; marker?: string }>();
      const entry = (list: string) => lists.get(list) ?? (lists.set(list, { rotated: [] }), lists.get(list)!);
      for (const f of files) {
        const full = path.join(cacheDir, f);
        const stamped = STAMPED.exec(f);
        if (stamped) entry(stamped[1]).rotated.push({ stamp: stamped[2], file: full });
        else if (f.endsWith('.jsonl')) entry(f.slice(0, -'.jsonl'.length)).live = full;
        else if (f.endsWith('.inprogress')) entry(f.slice(0, -'.inprogress'.length)).marker = full;
      }
      for (const [list, x] of [...lists].sort((a, b) => a[0].localeCompare(b[0]))) {
        x.rotated.sort((a, b) => a.stamp.localeCompare(b.stamp));
        x.rotated.forEach((r, i) => sources.push({ key: `${cat}/.cache/${path.basename(r.file)}`, kind: 'cache', cat, file: r.file, size: size(r.file), list, g: i + 1 }));
        const g = x.rotated.length + 1;
        if (x.live) sources.push({ key: `${cat}/.cache/${path.basename(x.live)}`, kind: 'cache', cat, file: x.live, size: size(x.live), list, g });
        if (x.marker) sources.push({ key: `${cat}/.cache/${path.basename(x.marker)}`, kind: 'marker', cat, file: x.marker, size: size(x.marker), list, g });
      }
    }
    const logs = path.join(dir, 'logs');
    if (fs.existsSync(logs)) {
      for (const f of fs.readdirSync(logs).sort()) if (f.endsWith('.log')) sources.push({ key: `${cat}/logs/${f}`, kind: 'log', cat, file: path.join(logs, f), size: size(path.join(logs, f)) });
    }
    const emails = path.join(dir, EMAILS_NAME);
    if (fs.existsSync(emails)) {
      const walk = (rel: string) => {
        for (const e of fs.readdirSync(path.join(emails, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(r);
          else if (e.name.toLowerCase().endsWith('.csv')) {
            const full = path.join(emails, r);
            sources.push({ key: `${cat}/emails/${r}`, kind: 'csv', cat, file: full, size: size(full), dest: path.join(outDir, EMAILS_NAME, cat, r) });
          }
        }
      };
      walk('');
    }
  }
  return sources;
}

const ledger = (db: Db) => (readManifest(db.files)?.migrations ?? {}) as Record<string, LedgerEntry>;

/** The sources that haven't been imported yet. */
export function pendingSources(db: Db): Source[] {
  const done = ledger(db);
  return listSources(db.outDir).filter((s) => !done[s.key]);
}

function record(db: Db, key: string, entry: LedgerEntry): void {
  const m = readManifest(db.files) ?? { schema: DB_SCHEMA, createdAt: new Date().toISOString() };
  m.migrations = { ...m.migrations, [key]: entry };
  writeManifest(db.files, m);
}

/** A cache line, or the several records an interrupted write glued onto it. */
const RECORD_START = /(?=\{"(?:v|site)":)/;
export function readLegacyCache(file: string): SiteResult[] {
  const rows: SiteResult[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as SiteResult);
      continue;
    } catch { /* salvage the records glued together on this line */ }
    for (const part of line.replace(/\0+/g, '').split(RECORD_START)) {
      if (!part.trim()) continue;
      try {
        rows.push(JSON.parse(part) as SiteResult);
      } catch { log.warn({ file }, `skipping an unreadable record in ${path.basename(file)}; its site will be scraped again`); }
    }
  }
  return rows;
}

function importPages(db: Db, s: Source, report: MigrationReport): LedgerEntry {
  const stats = { read: 0, imported: 0, skipped: 0, bad: 0 };
  const repo = db.pages;
  const prov = { cat: s.cat, list: null, run: 'legacy', site: null };
  const t0 = Date.now();
  scanLines(s.file, 0, (data, st, e) => {
    stats.read++;
    const t1 = data.indexOf(9, st);
    const t2 = t1 < 0 || t1 >= e ? -1 : data.indexOf(9, t1 + 1);
    const mode: Mode | null = data[st] === 0x68 ? 'http' : data[st] === 0x62 ? 'browser' : null;
    const at = t2 < 0 || t2 >= e ? NaN : Number(data.toString('latin1', t1 + 1, t2));
    if (!mode || !Number.isFinite(at) || data[t2 + 1] !== 0x7b || data[e - 1] !== 0x7d) { stats.bad++; return; }
    const key = data.toString('utf8', st + 1, t1);
    const body = data.toString('utf8', t2 + 1, e);
    const gone = body === '{"gone":1}';
    const line = gone ? goneLine(mode, key, at, prov) : pageLine(mode, key, at, prov, body);
    if (repo.importLine(mode, key, at, line, gone)) stats.imported++;
    else stats.skipped++;
    if (stats.read % 250_000 === 0) log.info({ ...stats, source: s.key }, `${s.key}: ${stats.read} lines read`);
  });
  repo.checkpoint();
  report.pages.read += stats.read;
  report.pages.imported += stats.imported;
  report.pages.skipped += stats.skipped;
  report.pages.bad += stats.bad;
  log.info({ ...stats, ms: Date.now() - t0 }, `${s.key}: ${stats.imported} pages imported, ${stats.skipped} already had a copy as new, ${stats.bad} unreadable`);
  return { at: new Date().toISOString(), size: s.size, ...stats };
}

function importCache(db: Db, s: Source, report: MigrationReport): LedgerEntry {
  const rows = readLegacyCache(s.file);
  const at = fs.statSync(s.file).mtimeMs;
  const who = { cat: s.cat!, list: s.list!, g: s.g!, run: 'legacy' };
  for (const r of rows) db.sites.append(who, r, at);
  report.rows += rows.length;
  log.info({ rows: rows.length }, `${s.key}: ${rows.length} site rows imported as generation ${s.g}`);
  return { at: new Date().toISOString(), size: s.size, rows: rows.length, g: s.g };
}

function importMarker(db: Db, s: Source, report: MigrationReport): LedgerEntry {
  const iso = /\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(fs.readFileSync(s.file, 'utf8'))?.[0];
  const a = iso ? Date.parse(iso) : fs.statSync(s.file).mtimeMs;
  db.runs.append({ t: 'list.start', run: 'legacy', a, cat: s.cat, list: s.list, g: s.g, mode: 'scrape', legacy: true, resumed: false, fresh: false });
  report.interrupted.push(`${s.cat}/${s.list}`);
  log.info({ list: `${s.cat}/${s.list}` }, `${s.key}: an interrupted scrape; the next run resumes it`);
  return { at: new Date().toISOString(), size: s.size };
}

/** "2026-10-30 03:40:05" in a summary header; the logs wrote UTC. */
const stampMs = (text: string) => Date.parse(text.replace(' ', 'T') + 'Z');
const HEADER = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (?:([^/\s]+)\/)?(\S+?)\.csv {2}\((.*)\)/;

function importLog(db: Db, s: Source, report: MigrationReport): LedgerEntry {
  const base = path.basename(s.file, '.log');
  const isUnique = base.startsWith('unique.');
  let events = 0;
  for (const block of fs.readFileSync(s.file, 'utf8').split(/\n{2,}/)) {
    const text = block.replace(/^\n+/, '').replace(/\s+$/, '');
    if (!text) continue;
    const h = HEADER.exec(text);
    let ev: { t: string; [k: string]: unknown };
    if (h) {
      const n = (re: RegExp) => { const m = re.exec(text); return m ? m.slice(1).map(Number) : undefined; };
      const websites = n(/Websites : (\d+) total \| (\d+) with emails \| (\d+) no emails found \| (\d+) failed/);
      const emails = n(/Emails {3}: (\d+) unique/);
      ev = {
        t: 'list.end', cat: s.cat ?? h[2] ?? null, list: h[3], status: 'finished', mode: h[4].split(':')[0], a: stampMs(h[1]),
        ...(websites || emails ? { counts: { ...(websites ? { sites: websites[0], withEmails: websites[1], noEmails: websites[2], failed: websites[3] } : {}), ...(emails ? { uniqueEmails: emails[0] } : {}) } } : {}),
        text,
      };
    } else if (/^=== unique /.test(text)) {
      const when = /^=== unique (\S+) — (\S+)/.exec(text);
      ev = { t: 'unique.end', cat: s.cat, label: when?.[1] ?? base.slice('unique.'.length), a: when ? Date.parse(when[2]) : fs.statSync(s.file).mtimeMs, text };
    } else {
      ev = { t: isUnique ? 'unique.end' : 'filter.end', cat: s.cat, list: isUnique ? undefined : base, a: fs.statSync(s.file).mtimeMs, text };
    }
    db.runs.append({ run: 'legacy', legacy: true, ...ev, a: Number.isFinite(ev.a) ? (ev.a as number) : fs.statSync(s.file).mtimeMs });
    // a legacy list.end must not end a list that a later import marks as interrupted: markers are imported last
    events++;
  }
  report.events += events;
  log.info({ events }, `${s.key}: ${events} history entries imported`);
  return { at: new Date().toISOString(), size: s.size, events };
}

function importCsv(s: Source, report: MigrationReport): LedgerEntry {
  const dest = s.dest!;
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  let copied = false;
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(s.file, dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, 0o600);
    const st = fs.statSync(s.file);
    fs.utimesSync(dest, st.atime, st.mtime);
    copied = true;
    report.csvs.copied++;
  } else if (fs.readFileSync(dest).equals(fs.readFileSync(s.file))) {
    report.csvs.copied++;
  } else {
    report.csvs.kept++;
    log.warn({ source: s.key, dest: path.relative(OUT_DIR, dest) }, `${path.relative(OUT_DIR, dest)} already exists with other content; the old ${s.key} was not copied over it`);
  }
  return { at: new Date().toISOString(), size: s.size, copied };
}

/** Runs of the old code that are still alive and could be writing the files about to be read. */
function liveLegacyRuns(outDir: string): string[] {
  const live: string[] = [];
  for (const { cat, dir } of findLegacy(outDir)) {
    const cache = path.join(dir, '.cache');
    if (!cat || !fs.existsSync(cache)) continue;
    for (const f of fs.readdirSync(cache)) {
      if (!f.endsWith('.lock')) continue;
      const pid = lockPid(path.join(cache, f));
      if (pid && pid !== process.pid && pidAlive(pid)) live.push(`${cat}/${f} (pid ${pid})`);
    }
  }
  return live;
}

const ORDER: Record<Source['kind'], number> = { pages: 0, cache: 1, log: 2, csv: 3, marker: 4 }; // markers last: see importLog

/**
 * Imports whatever the old layout holds that isn't in the database yet. Safe to repeat or resume. `dryRun` only
 * counts what there is.
 */
export function migrate(db: Db, opts: { dryRun?: boolean } = {}): MigrationReport {
  const report: MigrationReport = { sources: 0, done: 0, pages: { read: 0, imported: 0, skipped: 0, bad: 0 }, rows: 0, events: 0, interrupted: [], csvs: { copied: 0, kept: 0 }, dryRun: !!opts.dryRun };
  const todo = pendingSources(db).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  report.sources = todo.length;
  if (!todo.length) return report;
  const live = liveLegacyRuns(db.outDir);
  if (live.length) throw new Error(`a run of the old layout is still working on ${live.join(', ')}; wait for it to finish before migrating`);
  const bytes = todo.reduce((n, s) => n + s.size, 0);
  log.info({ sources: todo.length, bytes }, `${opts.dryRun ? 'Would import' : 'Importing'} ${todo.length} files (${(bytes / 2 ** 30).toFixed(2)} GB) of the old per-category layout into results/db/ and results/emails/; the old files are left untouched`);
  if (opts.dryRun) {
    for (const s of todo) log.info({ kind: s.kind, bytes: s.size }, `  ${s.kind.padEnd(6)} ${s.key} (${(s.size / 2 ** 20).toFixed(1)} MB)`);
    return report;
  }
  for (const s of todo) {
    const entry =
      s.kind === 'pages' ? importPages(db, s, report)
      : s.kind === 'cache' ? importCache(db, s, report)
      : s.kind === 'marker' ? importMarker(db, s, report)
      : s.kind === 'log' ? importLog(db, s, report)
      : importCsv(s, report);
    record(db, s.key, entry);
    report.done++;
  }
  db.sites.close();
  log.info(report, 'Import finished. The old per-category folders are untouched; delete them yourself once you are happy with the new layout');
  return report;
}
