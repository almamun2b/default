/**
 * Helps maintain src/data/given-names.txt. Lists first parts of two-part local parts in the stored results
 * ("firstname.lastname@…") that aren't in the list, with examples, most frequent first. Review by eye
 * and add the real given names to the file (lowercase, one per line). Writes nothing.
 *
 *   npx tsx scripts/given-names-report.ts [min-count]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/open.js';
import { OUT_DIR, ROOT } from '../src/paths.js';

const min = Number(process.argv[2] ?? 1);
const known = new Set(fs.readFileSync(path.join(ROOT, 'src', 'data', 'given-names.txt'), 'utf8').split('\n').filter(Boolean));

const unknown = new Map<string, Set<string>>();
const db = new Db(OUT_DIR, { readOnly: true });
db.sites.scanRows((row) => {
  for (const { email } of row.result?.emails ?? []) {
    const parts = email.split('@')[0].split(/[._-]+/).filter(Boolean);
    if (parts.length !== 2 || !parts.every((p) => /^[a-z']{3,12}$/.test(p))) continue;
    if (known.has(parts[0])) continue;
    if (!unknown.has(parts[0])) unknown.set(parts[0], new Set());
    unknown.get(parts[0])!.add(email);
  }
});
const rows = [...unknown].filter(([, s]) => s.size >= min).sort((a, b) => b[1].size - a[1].size);
for (const [first, emails] of rows) console.log(`${first.padEnd(14)} ${String(emails.size).padStart(4)}  ${[...emails].slice(0, 3).join(', ')}`);
console.log(`\n${rows.length} unknown first parts (min count ${min})`);
