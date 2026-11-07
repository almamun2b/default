/**
 * Shows what the current email/name rules would change in the stored results, without writing anything.
 * Use it after editing extract.ts (or the row assignment in output.ts) to review the effect on every real row
 * scraped so far.
 *
 *   npx tsx scripts/recheck-cache.ts            # all lists
 *   npx tsx scripts/recheck-cache.ts au.ford    # one file (or dealers/au.ford)
 *   npx tsx scripts/recheck-cache.ts --all      # print every change, not a sample
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { assignRows, recheckSite } from '../src/output.js';
import { Db } from '../src/db/open.js';
import { IN_DIR, OUT_DIR } from '../src/paths.js';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const only = args.filter((a) => !a.startsWith('--'));
const SAMPLE = 25;

// every list that has stored results (results/db/sites.jsonl); `id` is <group>/<base>
const db = new Db(OUT_DIR, { readOnly: true });
const files = db.sites.listSummaries()
  .map((l) => ({ group: l.cat, base: l.list, generation: l.generation, id: `${l.cat}/${l.list}` }))
  .sort((a, b) => a.id.localeCompare(b.id))
  .filter((c) => !only.length || only.includes(c.id) || only.includes(c.base));

/** The input list of a stored list, for its site order and name column; null when the input is gone. */
function inputOf(group: string, base: string) {
  for (const f of [path.join(IN_DIR, group, `${base}.csv`), path.join(IN_DIR, `${base}.csv`)]) {
    if (fs.existsSync(f)) {
      try { return readSites(f); } catch { return null; }
    }
  }
  return null;
}

/** What the CSV used to do: first site in input order wins, named by person, department, then business. */
function oldCredit(sites: string[], done: Map<string, SiteResult>): Map<string, string> {
  const credit = new Map<string, string>();
  for (const s of sites) for (const e of done.get(s)?.emails ?? []) if (!credit.has(e.email)) credit.set(e.email, s);
  return credit;
}

let rows = 0;
const dropped: string[] = [];
const decoded: string[] = [];
const nameLost: string[] = [];
const nameChanged: string[] = [];
const nameGained: string[] = [];
const moved: string[] = [];
const named: string[] = [];

for (const { group, base, generation, id } of files) {
  const done = db.sites.loadList(group, base, generation);
  for (const r of done.values()) {
    const after = new Map(recheckSite(r).emails.map((e) => [e.email, e]));
    const used = new Set<string>();
    for (const e of r.emails) {
      rows++;
      let now = after.get(e.email);
      if (!now) {
        const match = [...after.values()].find((a) => !used.has(a.email) && !r.emails.some((o: { email: string }) => o.email === a.email));
        if (match) { used.add(match.email); decoded.push(`${e.email} → ${match.email}`); now = match; } else { dropped.push(e.email); continue; }
      }
      if (e.name && !now.name) nameLost.push(`${e.email}: "${e.name}"`);
      else if (!e.name && now.name) nameGained.push(`${e.email}: "${now.name}"`);
      else if (e.name && now.name && e.name !== now.name) nameChanged.push(`${e.email}: "${e.name}" → "${now.name}"`);
    }
  }

  // Row assignment for the whole file: which site an email is credited to.
  const input = inputOf(group, base);
  const sites = input?.sites.filter((s) => done.has(s)) ?? [...done.keys()];
  const checked = new Map([...done].map(([s, r]) => [s, recheckSite(r)]));
  const before = oldCredit(sites, checked);
  const out = assignRows(sites, checked, input?.names);
  for (const [, email, site] of out.rows) {
    const was = before.get(email);
    if (was && was !== site) moved.push(`${id}: ${email}  ${new URL(was).hostname} → ${new URL(site).hostname}`);
  }
  if (out.kinds.input) named.push(`${id}: ${out.kinds.input} row(s) now named from the input's name column`);
}

const show = (title: string, list: string[]) => {
  console.log(`\n${title}: ${list.length}`);
  for (const l of showAll ? list : list.slice(0, SAMPLE)) console.log('  ' + l);
  if (!showAll && list.length > SAMPLE) console.log(`  … ${list.length - SAMPLE} more (--all to list)`);
};
console.log(`${files.length} list(s), ${rows} email rows`);
show('Emails dropped', dropped);
show('Emails decoded (ROT13)', decoded);
show('Person names removed', nameLost);
show('Person names changed', nameChanged);
show('Person names added', nameGained);
show('Emails credited to a different site', moved);
show('Input names used', named);
