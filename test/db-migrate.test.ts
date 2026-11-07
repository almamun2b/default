import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db/open.js';
import { findLegacy, migrate, pendingSources } from '../src/db/migrate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rec = (url: string, email: string, at: number) => JSON.stringify({ url, emails: [{ email, name: null }], links: [], at });
const siteRow = (site: string, extra: object = {}) => JSON.stringify({ v: 3, site, finalUrl: site, business: 'B', emails: [{ email: `x@${new URL(site).hostname}`, name: null, link: site }], pages: 1, usedBrowser: false, ...extra });

/** A results/ folder as the code before the database left it. */
function legacyTree(): string {
  const out = path.join(tmp(), 'results');
  // pages: two categories hold the same page; the newer copy must be the one kept
  put(path.join(out, 'pizza-au/.cache/.pages'), [
    `hexample.com/a\t100\t${rec('https://example.com/a', 'old@example.com', 100)}`,
    `bexample.com/a\t100\t${rec('https://example.com/a', 'b@example.com', 100)}`,
    `hexample.com/gone\t100\t{"gone":1}`,
    `hexample.com/cut\t100\t{"url":"https://example.com/cut","emai`, // a record cut off by a crash
    `hexample.com/after\t100\t${rec('https://example.com/after', 'after@example.com', 100)}`,
  ].join('\n') + '\n');
  put(path.join(out, 'pizza-nz/.cache/.pages'), [
    `hexample.com/a\t200\t${rec('https://example.com/a', 'new@example.com', 200)}`,
    `hother.com/x\t50\t${rec('https://other.com/x', 'x@other.com', 50)}`,
  ].join('\n') + '\n');
  // site results: a rotated cache (an earlier scrape), the live one with a glued record, and an interrupted list
  put(path.join(out, 'pizza-au/.cache/shops.au.20260101-000000.jsonl'), siteRow('https://old.com/') + '\n');
  const a = siteRow('https://a.com/'), b = siteRow('https://b.com/'), c = siteRow('https://c.com/');
  put(path.join(out, 'pizza-au/.cache/shops.au.jsonl'), `${a}${b}\n${siteRow('https://a.com/', { emails: [] })}\0\0\n${c}\n`);
  put(path.join(out, 'pizza-au/.cache/chains.au.jsonl'), '');
  put(path.join(out, 'pizza-au/.cache/chains.au.inprogress'), '4242 2026-11-01T01:02:03.000Z\n');
  // summaries
  put(path.join(out, 'pizza-au/logs/shops.au.log'), [
    '[2026-10-30 03:40:05] pizza-au/shops.au.csv  (scrape: unlimited pages, took 1h 0m)',
    '  Websites : 3 total | 2 with emails | 1 no emails found | 0 failed',
    '  Emails   : 5 unique (0 person name, 0 department page title, 0 input name, 5 business name)',
    '',
    '[2026-10-31 03:40:05] pizza-au/shops.au.csv  (summary rebuilt from cache, took 2s)',
    '  Websites : 3 total | 3 with emails | 0 no emails found | 0 failed',
    '',
  ].join('\n'));
  put(path.join(out, 'pizza-au/logs/unique.pizza-au.log'), '=== unique pizza-au — 2026-10-25T15:16:59.075Z (run a9ca99be) ===\n  Files    : 1 (shops.au 2)\n\n');
  // outputs
  put(path.join(out, 'pizza-au/emails/shops.au.csv'), 'name,email,website,link\nA,x@a.com,https://a.com/,l\n');
  put(path.join(out, 'pizza-au/emails/unique/pizza-au.csv'), 'name,email,website,link\nA,x@a.com,https://a.com/,l\n');
  put(path.join(out, 'unique/all.csv'), 'name,email,website,link\n');
  return out;
}

const snapshot = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${fs.statSync(path.join(e.parentPath, e.name)).size}:${fs.statSync(path.join(e.parentPath, e.name)).mtimeMs}`).sort();

test('migrate: pages, site results, history, interrupted lists and CSVs come over; the old files are untouched', () => {
  const out = legacyTree();
  const before = snapshot(out);
  assert.deepEqual(findLegacy(out).map((l) => l.cat), ['pizza-au', 'pizza-nz', null]);
  const db = new Db(out);
  const report = migrate(db);

  // pages: 7 lines; one is cut off; pizza-nz has a newer copy of a page pizza-au has (the older stays as dead bytes, the index points at the newer)
  assert.deepEqual(report.pages, { read: 7, imported: 6, skipped: 0, bad: 1 });
  assert.equal(db.pages.pages, 5);
  assert.equal(db.pages.getRecord('http', 'example.com/a')?.emails[0].email, 'new@example.com', 'the newest copy of a page wins');
  assert.equal(db.pages.getRecord('browser', 'example.com/a')?.emails[0].email, 'b@example.com', 'modes stay apart');
  assert.equal(db.pages.getRecord('http', 'example.com/gone'), undefined);
  assert.equal(db.pages.has('http', 'example.com/gone'), 100, 'a known 404 is remembered');
  assert.equal(db.pages.getRecord('http', 'example.com/cut'), undefined);
  assert.ok(db.pages.getRecord('http', 'example.com/after'), 'a page after the damaged line is still imported');
  assert.ok(db.pages.getRecord('http', 'other.com/x'));
  const first = JSON.parse(fs.readFileSync(db.files.pages, 'utf8').split('\n')[0]);
  assert.deepEqual([first.v, first.cat, first.run], [1, 'pizza-au', 'legacy']);

  // site results: the rotated cache is generation 1, the live one generation 2 with its glued record recovered
  assert.deepEqual([...db.sites.loadList('pizza-au', 'shops.au', 1).keys()], ['https://old.com/']);
  assert.equal(db.sites.generation('pizza-au', 'shops.au'), 2);
  const live = db.sites.loadList('pizza-au', 'shops.au');
  assert.deepEqual([...live.keys()].sort(), ['https://a.com/', 'https://b.com/', 'https://c.com/']);
  assert.equal(live.get('https://a.com/')!.emails.length, 0, 'the last row of a site wins');
  assert.equal(report.rows, 5);

  // an .inprogress marker is a list that was started and not ended: the next run resumes it
  assert.deepEqual(report.interrupted, ['pizza-au/chains.au']);
  assert.equal(db.runs.interrupted('pizza-au', 'chains.au')?.legacy, true);
  assert.equal(db.runs.interrupted('pizza-au', 'shops.au'), undefined, 'a list whose summary was logged is finished');
  assert.equal(db.generation('pizza-au', 'chains.au'), 1);

  // history keeps the original text
  const ends: Record<string, any>[] = [];
  db.runs.scan((e) => ends.push(e));
  const lists = ends.filter((e) => e.t === 'list.end');
  assert.equal(lists.length, 2);
  assert.deepEqual([lists[0].cat, lists[0].list, lists[0].counts.sites, lists[0].counts.withEmails, lists[0].legacy], ['pizza-au', 'shops.au', 3, 2, true]);
  assert.equal(lists[0].a, Date.parse('2026-10-30T03:40:05Z'));
  assert.match(lists[0].text, /Emails {3}: 5 unique/);
  assert.equal(ends.filter((e) => e.t === 'unique.end').length, 1);

  // outputs are copied to results/emails/<category>/
  assert.equal(fs.readFileSync(path.join(out, 'emails/pizza-au/shops.au.csv'), 'utf8'), 'name,email,website,link\nA,x@a.com,https://a.com/,l\n');
  assert.ok(fs.existsSync(path.join(out, 'emails/pizza-au/unique/pizza-au.csv')));
  assert.ok(fs.existsSync(path.join(out, 'emails/unique/all.csv')));
  db.close();

  const after = snapshot(out).filter((f) => !/^(db|emails)\//.test(f));
  assert.deepEqual(after, before, 'nothing in the old layout was changed or deleted');
});

test('migrate: repeating it imports nothing more, and an interrupted import resumes', () => {
  const out = legacyTree();
  let db = new Db(out);
  migrate(db);
  const sizes = [db.files.pages, db.files.sites, db.files.runs].map((f) => fs.statSync(f).size);
  assert.equal(pendingSources(db).length, 0);
  const again = migrate(db);
  assert.equal(again.sources, 0);
  assert.deepEqual([db.files.pages, db.files.sites, db.files.runs].map((f) => fs.statSync(f).size), sizes);
  db.close();

  // forget one source in the ledger, as if the import died right before recording it: only that one is redone
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'db/manifest.json'), 'utf8'));
  delete manifest.migrations['pizza-nz/.cache/.pages'];
  fs.writeFileSync(path.join(out, 'db/manifest.json'), JSON.stringify(manifest));
  db = new Db(out);
  assert.deepEqual(pendingSources(db).map((s) => s.key), ['pizza-nz/.cache/.pages']);
  const redo = migrate(db);
  assert.deepEqual(redo.pages, { read: 2, imported: 0, skipped: 2, bad: 0 }, 'its pages are already in the store');
  assert.equal(db.pages.pages, 5);
  db.close();
});

test('migrate: refuses while a run of the old layout is still working, and --dry-run writes nothing', () => {
  const out = legacyTree();
  put(path.join(out, 'pizza-au/.cache/shops.au.lock'), String(process.ppid));
  const dry = new Db(out, { readOnly: true });
  assert.throws(() => migrate(dry, { dryRun: true }), /still working on pizza-au\/shops\.au\.lock/);
  fs.rmSync(path.join(out, 'pizza-au/.cache/shops.au.lock'));
  const report = migrate(dry, { dryRun: true });
  assert.ok(report.sources > 5);
  assert.ok(!fs.existsSync(path.join(out, 'db')), 'a dry run leaves no database behind');
  assert.ok(!fs.existsSync(path.join(out, 'emails')));
  dry.close();
});

test('migrate: an existing results/db with empty files (as the owner created) is adopted', () => {
  const out = legacyTree();
  put(path.join(out, 'db/pages.jsonl'), '');
  put(path.join(out, 'db/run-history.jsonl'), '');
  const db = new Db(out);
  migrate(db);
  assert.equal(db.pages.pages, 5);
  db.close();
});
