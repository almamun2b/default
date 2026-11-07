/**
 * Checks that everything in the old per-category layout made it into results/db/ and results/emails/. Reads
 * only (it takes the page-store lock, so don't run it during a scrape). Exits 1 if anything is missing.
 *
 *   npm run db:verify [-- --sample=2000]
 *
 * For each old category it compares: the line count of `.pages` against what the import read, a random sample of
 * its pages against the page store, every list's last row per site against the database (emails and error), the
 * interrupted-scrape markers against the run history, and every output CSV against its copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/open.js';
import { listSources, readLegacyCache, type Source } from '../src/db/migrate.js';
import { scanLines } from '../src/db/jsonl.js';
import type { Mode } from '../src/db/pages-repo.js';
import { OUT_DIR } from '../src/paths.js';

const sample = Number(process.argv.find((a) => a.startsWith('--sample='))?.slice(9) ?? 2000);
const db = new Db(OUT_DIR);
const problems: string[] = [];
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const bad = (msg: string) => { problems.push(msg); console.log(`  FAIL  ${msg}`); };
const ledger = (JSON.parse(fs.readFileSync(db.files.manifest, 'utf8')).migrations ?? {}) as Record<string, Record<string, number>>;

function checkPages(s: Source): void {
  const l = ledger[s.key];
  if (!l) return bad(`${s.key}: not imported yet`);
  let lines = 0;
  const picks: { mode: Mode; key: string; at: number }[] = [];
  const every = Math.max(1, Math.floor((l.read ?? 1) / sample));
  scanLines(s.file, 0, (data, st, e) => {
    lines++;
    if (lines % every !== 0) return;
    const t1 = data.indexOf(9, st), t2 = data.indexOf(9, t1 + 1);
    if (t1 < 0 || t2 < 0 || t2 >= e) return;
    picks.push({ mode: data[st] === 0x68 ? 'http' : 'browser', key: data.toString('utf8', st + 1, t1), at: Number(data.toString('latin1', t1 + 1, t2)) });
  });
  if (l.imported + l.skipped + l.bad !== lines) bad(`${s.key}: ${lines} lines, but the import accounts for ${l.imported + l.skipped + l.bad}`);
  else ok(`${s.key}: ${lines} lines = ${l.imported} imported + ${l.skipped} already present + ${l.bad} unreadable`);
  let missing = 0;
  for (const p of picks) {
    const at = db.pages.has(p.mode, p.key);
    if (at === undefined || at < p.at) missing++;
  }
  if (missing) bad(`${s.key}: ${missing} of ${picks.length} sampled pages are missing or older in the page store`);
  else ok(`${s.key}: ${picks.length} sampled pages found, as new or newer`);
}

function checkCache(s: Source): void {
  if (!ledger[s.key]) return bad(`${s.key}: not imported yet`);
  const last = new Map(readLegacyCache(s.file).map((r) => [r.site, r]));
  const stored = db.sites.loadList(s.cat!, s.list!, s.g);
  const diff = [...last].filter(([site, r]) => { const x = stored.get(site); return !x || x.emails.length !== r.emails.length || x.error !== r.error; });
  if (diff.length || stored.size !== last.size) bad(`${s.key}: ${last.size} sites in the old cache, ${stored.size} stored; ${diff.length} differ`);
  else ok(`${s.key}: ${last.size} sites match`);
}

for (const s of listSources(OUT_DIR)) {
  if (s.kind === 'pages') checkPages(s);
  else if (s.kind === 'cache') checkCache(s);
  else if (s.kind === 'marker') {
    if (!ledger[s.key]) bad(`${s.key}: not imported yet`);
    else if (db.runs.interrupted(s.cat!, s.list!)) ok(`${s.cat}/${s.list}: interrupted, will resume`);
    else bad(`${s.cat}/${s.list}: was interrupted but the history does not say so`);
  } else if (s.kind === 'csv') {
    if (!s.dest || !fs.existsSync(s.dest)) bad(`${s.key}: not copied`);
    else if (!fs.readFileSync(s.dest).equals(fs.readFileSync(s.file))) console.log(`  note  ${path.relative(OUT_DIR, s.dest)} differs from the old ${s.key} (rebuilt since?)`);
  } else if (!ledger[s.key]) bad(`${s.key}: not imported yet`);
}
db.close();
console.log(problems.length ? `\n${problems.length} problem(s).` : '\nEverything in the old layout is in the database.');
process.exit(problems.length ? 1 : 0);
