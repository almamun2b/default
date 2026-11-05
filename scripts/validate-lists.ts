/**
 * Checks website lists before they are scraped: invalid URLs, platform/social/directory/.edu sites and duplicates
 * (same host + path, as `readSites()` dedupes) inside a file and across the files of a category folder.
 *
 *   npx tsx scripts/validate-lists.ts <category-dir|file.csv>... [--write] [--only-country[=cc]]
 *   npx tsx scripts/validate-lists.ts websites/cafes-au websites/cafes-nz --only-country
 *
 * `--only-country` also flags sites whose domain ends in another country's code (generic domains and the target
 * country's own stay). The country is the `<cc>` of each file name (`cafes.au.csv`), or `=cc` for every file.
 *
 * A dry run by default. `--write` rewrites the offending files without those rows, but only files that are not in
 * `HEAD` yet (lists that were already committed are never edited, owner rule); a duplicate is removed from the
 * later file, files in `HEAD` come first, then the rest by name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { readSites, siteKey } from '../src/input.js';
import { ROOT } from '../src/paths.js';
import { foreignTld, isBlocked } from './new-list.js';

export interface FileReport {
  file: string;
  rows: { name: string; website: string }[]; // rows worth keeping
  total: number; // distinct sites the file's own reader found
  invalid: number;
  blocked: number;
  foreign: number; // another country's domain (only with the country option)
  repeated: number; // twice in the file
  known: number; // already in an earlier file of the category
  noName: number;
}

/** Validate `files` in the given order; a site already seen in an earlier file counts as `known` in the later one. */
export function validateFiles(files: string[], country?: string | true): FileReport[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const input = readSites(file);
    const r: FileReport = { file, rows: [], total: input.sites.length, invalid: input.invalid, blocked: 0, foreign: 0, repeated: input.duplicates, known: 0, noName: 0 };
    const own = new Set<string>();
    const cc = country === true ? /\.([a-z]{2})\.csv$/i.exec(file)?.[1] : country;
    for (const s of input.sites) {
      if (isBlocked(s)) { r.blocked++; continue; }
      if (cc && foreignTld(s, cc)) { r.foreign++; continue; }
      const k = siteKey(s);
      if (seen.has(k)) { r.known++; continue; }
      own.add(k);
      const url = new URL(s);
      url.hash = '';
      const name = input.names.get(s) ?? '';
      if (!name) r.noName++;
      r.rows.push({ name: name || url.hostname.replace(/^www\./, ''), website: url.toString().replace(/\/$/, '') });
    }
    for (const k of own) seen.add(k);
    return r;
  });
}

const dropped = (r: FileReport) => r.invalid + r.blocked + r.foreign + r.repeated + r.known;

function inHead(file: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${path.relative(ROOT, path.resolve(file)).split(path.sep).join('/')}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function csvFiles(arg: string): string[] {
  if (fs.statSync(arg).isDirectory()) return fs.readdirSync(arg).filter((f) => f.toLowerCase().endsWith('.csv')).map((f) => path.join(arg, f));
  return [arg];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const onlyArg = args.find((a) => a === '--only-country' || a.startsWith('--only-country='));
  const country = onlyArg ? (onlyArg.split('=')[1]?.toLowerCase() ?? true) : undefined;
  const targets = args.filter((a) => !a.startsWith('--'));
  if (!targets.length) {
    console.error('usage: validate-lists.ts <category-dir|file.csv>... [--write] [--only-country[=cc]]');
    process.exit(2);
  }
  for (const t of targets) {
    const files = csvFiles(t).sort((a, b) => Number(inHead(b)) - Number(inHead(a)) || a.localeCompare(b));
    const reports = validateFiles(files, country);
    console.log(`\n${t}: ${reports.reduce((n, r) => n + r.rows.length, 0)} unique sites in ${files.length} files`);
    for (const r of reports) {
      const committed = inHead(r.file);
      console.log(`  ${path.basename(r.file)} ${committed ? '(committed) ' : ''}rows ${r.total + r.repeated + r.invalid} → keep ${r.rows.length}: invalid ${r.invalid}, blocked platforms ${r.blocked}, other-country domains ${r.foreign}, repeated in file ${r.repeated}, in an earlier file ${r.known}, without a name ${r.noName}`);
      if (!dropped(r)) continue;
      if (!write) continue;
      if (committed) { console.log('    committed file: not edited'); continue; }
      fs.writeFileSync(r.file, stringify(r.rows, { header: true, columns: ['name', 'website'] }));
      console.log('    rewritten');
    }
  }
  if (!write) console.log('\ndry run: nothing written (add --write to clean files not yet committed)');
}
