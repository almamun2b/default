/**
 * Rebuilds the word lists in src/data/ from downloaded collections plus our own stored data. Writes only the
 * derived lists, never the downloads. Safe to re-run: a hand-made list never loses an entry.
 *
 *   npx tsx scripts/build-word-lists.ts --from /tmp/wordlists-dl      # given-names, surnames, places, free-mail, name-words
 *   npx tsx scripts/build-word-lists.ts --role-candidates             # prints local parts that recur on many domains (review by eye)
 *
 * --from DIR expects: ssa/baby-names.csv, census/x/Names_2010Census.csv, abs/SAL_2021_AUST.xlsx, linz/gaz.csv,
 * free/domains.json (see src/data/SOURCES.md for where each comes from). --dict FILE (repeatable) adds
 * dictionaries; the defaults are /usr/share/dict/american-english and british-english when present.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDomain } from 'tldts';
import { Db } from '../src/db/open.js';
import { DEPT_WORDS } from '../src/extract.js';
import { IN_DIR, OUT_DIR, ROOT } from '../src/paths.js';

const DATA = path.join(ROOT, 'src', 'data');
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flags = (n: string) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const read = (f: string) => fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
const write = (f: string, lines: string[]) => fs.writeFileSync(path.join(DATA, f), lines.join('\n') + '\n');
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const tokens = (s: string, min = 3, max = 14) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= min && t.length <= max);

const role = new Set(read('role-words.txt'));
const placeWords = new Set(read('place-words.txt'));
const blocked = (w: string) => role.has(w) || placeWords.has(w) || DEPT_WORDS.has(w);

// ---- stored data: business names and recurring local parts ----
function ownData() {
  const words = new Map<string, number>();
  const bump = (w: string) => words.set(w, (words.get(w) ?? 0) + 1);
  const db = new Db(OUT_DIR, { readOnly: true });
  const domainsOf = new Map<string, Set<string>>();
  const seen = new Set<string>();
  db.sites.scanRows((row) => {
    const r = row.result;
    if (!r) return;
    if (r.business && !/:\/\//.test(r.business) && !/^[\w.-]+\.[a-z]{2,}$/i.test(r.business)) for (const t of tokens(r.business)) bump(t);
    for (const e of r.emails) {
      if (seen.has(e.email)) continue;
      seen.add(e.email);
      const [local, domain] = e.email.split('@');
      const reg = getDomain(domain) ?? domain;
      for (const p of [local, ...local.split(/[._-]+/)]) {
        if (!/^[a-z]{3,20}$/.test(p)) continue;
        if (!domainsOf.has(p)) domainsOf.set(p, new Set());
        domainsOf.get(p)!.add(reg);
      }
    }
  });
  db.close();
  for (const f of walk(IN_DIR)) {
    try {
      const rows = parse(fs.readFileSync(f), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as Record<string, string>[];
      for (const r of rows) for (const [k, v] of Object.entries(r)) if (v && /name/i.test(k) && !/user|file|domain|url|site/i.test(k)) for (const t of tokens(v)) bump(t);
    } catch { /* skip unreadable list */ }
  }
  return { words, domainsOf };
}
function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.csv')) yield p;
  }
}

if (args.includes('--role-candidates')) {
  const { domainsOf } = ownData();
  const known = new Set([...read('given-names.txt'), ...role, ...DEPT_WORDS]);
  const out = [...domainsOf].filter(([p, d]) => d.size >= 15 && !known.has(p)).sort((a, b) => b[1].size - a[1].size);
  for (const [p, d] of out) console.log(`${p.padEnd(22)} ${d.size}`);
  console.error(`${out.length} candidates`);
  process.exit(0);
}

const from = flag('--from');
if (!from) { console.error('usage: build-word-lists.ts --from DIR | --role-candidates'); process.exit(1); }
const dicts = flags('--dict');
for (const d of ['/usr/share/dict/american-english', '/usr/share/dict/british-english']) if (!dicts.length && fs.existsSync(d)) dicts.push(d);

// ---- dictionary: lower-case entries are common words (capitalised ones are proper nouns) ----
const common = new Set<string>();
for (const f of dicts) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (/^[a-z]{3,14}$/.test(l)) common.add(l);
console.log(`dictionary words: ${common.size}`);

// ---- places: ABS suburbs and localities 2021 (CC BY 4.0) + LINZ NZ Gazetteer (CC BY 4.0) ----
const places = new Set<string>();
const NOT_PLACE = /^(australia|aus|new south wales|victoria|queensland|south australia|western australia|tasmania|northern territory|australian capital territory|other territories|no usual address|migratory|offshore|shipping|unincorporated|outside australia|unknown)/i;
const xml = execFileSync('unzip', ['-p', path.join(from, 'abs', 'SAL_2021_AUST.xlsx'), 'xl/sharedStrings.xml'], { maxBuffer: 1 << 30 }).toString('utf8');
const absNames = new Set<string>();
for (const m of xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)) {
  const t = m[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  if (/^[A-Za-z][A-Za-z' .-]+( \([A-Za-z.]+\))?$/.test(t) && !NOT_PLACE.test(t)) absNames.add(t.replace(/ \([A-Za-z.]+\)$/, ''));
}
for (const n of absNames) for (const t of tokens(n)) places.add(t);
console.log(`ABS place names: ${absNames.size}`);
const LINZ_TYPES = new Set(['Locality', 'Suburb', 'Town', 'City', 'Settlement', 'Rural Settlement', 'Village', 'Region']);
const gaz = parse(fs.readFileSync(path.join(from, 'linz', 'gaz.csv')), { columns: true, bom: true, relax_column_count: true }) as { name: string; feat_type: string }[];
let nz = 0;
for (const r of gaz) if (LINZ_TYPES.has(r.feat_type)) { nz++; for (const t of tokens(r.name)) places.add(t); }
console.log(`LINZ place names: ${nz}`);
write('places.txt', [...places].sort());
console.log(`places: ${places.size} words`);

// ---- given names (US SSA, public domain): in the yearly top 1000 for 5+ years ----
const ssa = parse(fs.readFileSync(path.join(from, 'ssa', 'baby-names.csv')), { columns: true }) as { year: string; name: string; percent: string }[];
const yearsOf = new Map<string, Set<string>>(), peak = new Map<string, number>();
for (const r of ssa) {
  const n = r.name.toLowerCase();
  if (!/^[a-z]{3,12}$/.test(n)) continue;
  (yearsOf.get(n) ?? yearsOf.set(n, new Set()).get(n)!).add(r.year);
  peak.set(n, Math.max(peak.get(n) ?? 0, Number(r.percent)));
}
const byPeak = [...peak].sort((a, b) => b[1] - a[1]).map(([n]) => n);
const veryCommon = new Set(byPeak.slice(0, 1500));
const given = new Set(read('given-names.txt'));
let givenAdded = 0;
for (const [n, years] of yearsOf) {
  if (years.size < 5 || given.has(n) || blocked(n) || !/[aeiouy]/.test(n)) continue;
  if (common.has(n) && !veryCommon.has(n)) continue; // king, young, royal, major …
  if (places.has(n) && !veryCommon.has(n)) continue; // richmond, branson, indiana: a suburb or town before a person
  given.add(n); givenAdded++;
}
write('given-names.txt', [...given].sort());
console.log(`given-names: +${givenAdded} -> ${given.size}`);

// ---- surnames (US Census 2010, public domain): the 50,000 most common, in rank order ----
const sur = parse(fs.readFileSync(path.join(from, 'census', 'x', 'Names_2010Census.csv')), { columns: true }) as { name: string; rank: string }[];
const surnames: string[] = [];
for (const r of sur) {
  const n = r.name.toLowerCase(), rank = Number(r.rank);
  if (rank > 50000 || !/^[a-z]{3,14}$/.test(n) || !/[aeiouy]/.test(n) || blocked(n)) continue;
  if (common.has(n) && rank > 2000) continue; // town, service, church …
  surnames.push(n);
}
write('surnames.txt', surnames);
console.log(`surnames: ${surnames.length}`);

// ---- free-mail providers (Kikobeats/free-email-domains, MIT) ----
const free = new Set(read('free-mail-domains.txt'));
for (const d of JSON.parse(fs.readFileSync(path.join(from, 'free', 'domains.json'), 'utf8')) as string[]) if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d.toLowerCase())) free.add(d.toLowerCase());
write('free-mail-domains.txt', [...free].sort());
console.log(`free-mail-domains: ${free.size}`);

// ---- splitter vocabulary: word and a weight (our own data counts most; dictionary-only words weigh 1) ----
const own = ownData().words;
const weight = new Map<string, number>();
const add = (w: string, n: number) => { if (/^[a-z]{4,14}$/.test(w)) weight.set(w, (weight.get(w) ?? 0) + n); };
for (const [w, n] of own) if (n >= 2) add(w, n);
for (const w of given) add(w, 3);
surnames.slice(0, 20000).forEach((w) => add(w, 2));
for (const w of places) add(w, 2);
for (const w of [...role, ...DEPT_WORDS]) add(w, 3);
for (const w of common) add(w, 1);
const vocab = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
write('name-words.txt', vocab.map(([w, n]) => `${w} ${n}`));
console.log(`name-words: ${vocab.length}`);
