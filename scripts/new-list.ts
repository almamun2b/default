/**
 * Turns a CSV of candidate sites into a new list file in a category folder, never touching the existing ones:
 * the file is `<list>.<cc>.csv` if the category has no such list, else `<list>-2.<cc>.csv`, `-3`, ... It holds
 * only sites that are in no CSV of the category yet (same host + path as `readSites()` dedupes) and are not
 * ordering platforms, social pages or directories.
 *
 *   npx tsx scripts/new-list.ts <category> <list> <cc> <candidates.csv> [--dry-run] [--append] [--only-country]
 *   npx tsx scripts/new-list.ts dentists-au dentists au /scratch/au.candidates.csv --dry-run
 *
 * One new file per list per session: the first batch creates `-2` (or the next free number), further batches in
 * the same session use `--append`, which adds to that numbered file (never to the unnumbered base list).
 *
 * `--only-country` also drops sites whose domain ends in another country's code (`.co.uk` in an `au` list); generic
 * domains (`.com`, `.net`, `.shop`, ...) and the target country's own (`.com.au`) stay.
 *
 * The candidates need a website column (same detection as any input list) and may have a name column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { getDomain, parse as parseHost } from 'tldts';
import { readSites, siteKey } from '../src/input.js';
import { IN_DIR } from '../src/paths.js';

/** Registrable domains that are never a business's own site: ordering, social, review and directory platforms. */
export const BLOCKED_DOMAINS = new Set([
  'ubereats.com', 'menulog.com.au', 'menulog.co.nz', 'doordash.com', 'deliveroo.com.au', 'deliveroo.co.nz', 'foodora.com', 'order.online',
  'dineplan.com', 'opentable.com', 'opentable.com.au', 'thefork.com', 'zomato.com', 'resdiary.com', 'sevenrooms.com', 'bookenzy.com',
  'facebook.com', 'fb.com', 'instagram.com', 'linktr.ee', 'linktree.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'pinterest.com',
  'linkedin.com', 'google.com', 'goo.gl', 'g.page', 'business.site', 'tripadvisor.com', 'tripadvisor.com.au', 'tripadvisor.co.nz', 'yelp.com',
  'yellowpages.com.au', 'yellowpages.co.nz', 'truelocal.com.au', 'hotfrog.com.au', 'hotfrog.co.nz', 'localsearch.com.au', 'localsearch.co.nz',
  'wikipedia.org', 'wikidata.org', 'openstreetmap.org', 'booking.com', 'eatclub.com.au', 'hungryhungry.com', 'mealme.ai', 'wixsite.com',
  'booknorder.co.nz', 'bopple.app', 'ordermeal.co.nz', 'posbosshq.com', 'flipdish.com',
  'nextorder.com', 'nextorder.com.au', 'localize123.com', 'ozfoodhunter.com.au', 'edan.io', 'bitebusiness.com', 'ordermate.online', 'orderup.com.au', 'orderfromus.com.au',
  'cafeleader.com', 'eatnow.com.au', 'tuckerfox.com.au', 'order.store', 'yqme.com.au', 'wowapps.com', 'restoplus.com', 'orderexperience.net', 'menusonly.com.au',
  'zwift.com.au', 'yumbojumbo.com.au', 'tafensw.edu.au',
  'bit.ly', 'share.google', 'g.co', 'yalwa.com.au', 'communityguide.com.au', 'agfg.com.au', 'menumania.co.nz', 'localist.co.nz', 'restoguides.com',
  'restaurantsnapshot.com', 'restaurantwebexperts.com', 'restaurantwebexpert.com', 'mryum.com', 'nowbookit.com', 'resos.com', '9map.top',
  'beanhunter.com', 'abacus.co', 'trademe.co.nz', 'ebay.com.au', 'ebay.com', 'gumtree.com.au', 'carsales.com.au',
]);

export function isBlocked(url: string): boolean {
  const host = new URL(url).hostname;
  if (host.endsWith('.edu.au') || host.endsWith('.edu.nz') || host.endsWith('.ac.nz')) return true; // schools and universities are never the business
  if (host.endsWith('.gov.au') || host.endsWith('.govt.nz')) return true; // councils and agencies list places, they are not the business
  const d = getDomain(host);
  return !!d && BLOCKED_DOMAINS.has(d);
}

/** Two-letter endings that local businesses use as ordinary generic domains (`.co`, `.io`, `.cc`, `.ly`, ...), not as a country marker. */
export const GENERIC_CC_TLDS = new Set(['co', 'io', 'me', 'tv', 'ai', 'cc', 'ly', 'gd', 'to', 'fm', 'app']);

/** True when the site's domain ends in another country's code (`.co.uk` in an AU list, `.com.au` in an NZ one).
 * Generic endings (`.com`, `.net`, `.shop`, `.melbourne`, GENERIC_CC_TLDS) and the target country's own are kept. */
export function foreignTld(url: string, cc: string): boolean {
  const suffix = parseHost(new URL(url).hostname).publicSuffix;
  const tld = suffix?.split('.').pop() ?? '';
  return tld.length === 2 && tld !== cc.toLowerCase() && !GENERIC_CC_TLDS.has(tld);
}

/** The next free file name for `list` in `dir`: the unnumbered file counts as 1, so the first new one is `-2`. */
export function nextListName(dir: string, list: string, cc: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(list)}(?:-(\\d+))?\\.${esc(cc)}\\.csv$`, 'i');
  let max = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = re.exec(f);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  return max === 0 ? `${list}.${cc}.csv` : `${list}-${max + 1}.${cc}.csv`;
}

/** The highest numbered file (`-2` or more) of `list` in `dir`, or null. The unnumbered base list is never a target. */
export function currentListName(dir: string, list: string, cc: string): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(list)}-(\\d+)\\.${esc(cc)}\\.csv$`, 'i');
  let max = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = re.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max >= 2 ? `${list}-${max}.${cc}.csv` : null;
}

export interface NewList {
  file: string;
  rows: { name: string; website: string }[];
  candidates: number;
  invalid: number;
  blocked: number;
  foreign: number; // another country's domain, only counted with onlyCountry
  known: number; // already in a CSV of the category
  repeated: number; // twice among the candidates
}

/** `append` adds to this session's numbered file instead of starting the next one (one new file per list per session). */
export function buildList(dir: string, list: string, cc: string, candidatesFile: string, append = false, onlyCountry = false): NewList {
  const known = new Set<string>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')) : []) {
    for (const s of readSites(path.join(dir, f)).sites) known.add(siteKey(s));
  }
  const input = readSites(candidatesFile);
  const current = append ? currentListName(dir, list, cc) : null;
  const out: NewList = { file: path.join(dir, current ?? nextListName(dir, list, cc)), rows: [], candidates: input.sites.length + input.duplicates, invalid: input.invalid, blocked: 0, foreign: 0, known: 0, repeated: input.duplicates };
  for (const s of input.sites) {
    if (isBlocked(s)) { out.blocked++; continue; }
    if (onlyCountry && foreignTld(s, cc)) { out.foreign++; continue; }
    const k = siteKey(s);
    if (known.has(k)) { out.known++; continue; }
    known.add(k);
    const url = new URL(s);
    url.hash = '';
    out.rows.push({ name: input.names.get(s) ?? url.hostname.replace(/^www\./, ''), website: url.toString().replace(/\/$/, '') });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const append = args.includes('--append');
  const onlyCountry = args.includes('--only-country');
  const [category, list, cc, candidates] = args.filter((a) => !a.startsWith('--'));
  if (!category || !list || !cc || !candidates) {
    console.error('usage: new-list.ts <category> <list> <cc (any country code)> <candidates.csv> [--dry-run] [--append] [--only-country]');
    process.exit(2);
  }
  const r = buildList(path.join(IN_DIR, category), list, cc, candidates, append, onlyCountry);
  console.log(`${r.file}: ${r.rows.length} new sites from ${r.candidates} candidates (invalid ${r.invalid}, blocked platforms ${r.blocked}, other-country domains ${r.foreign}, already in the category ${r.known}, repeated ${r.repeated})`);
  if (!dry && r.rows.length) {
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    const exists = fs.existsSync(r.file);
    const csv = stringify(r.rows, { header: !exists, columns: ['name', 'website'] });
    if (exists) fs.appendFileSync(r.file, csv);
    else fs.writeFileSync(r.file, csv);
    console.log('written');
  } else if (dry) console.log('dry run: nothing written');
}
