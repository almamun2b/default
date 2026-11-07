import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { LIST_FLAGS, parseArgs, suffixFilter, USAGE } from '../src/cli.js';
import { DEFAULT_OPTIONS, type SiteResult } from '../src/crawler.js';
import { describeFilter, filterRows, filterTag, keepEmail, matchesSuffix, parseSuffixes } from '../src/filter.js';
import { Db } from '../src/db/open.js';
import { fileLayout } from '../src/paths.js';
import { filterFile, filteredPath, previewFile, processFile, writeUnique } from '../src/run.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-filter-'));
const site = (s: string, emails: string[]): SiteResult => ({
  site: s, finalUrl: s, business: 'Biz', pages: 1, usedBrowser: false, emails: emails.map((email) => ({ email, name: null, link: `${s}contact` })),
});
const readCsv = (file: string) => (parse(fs.readFileSync(file, 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => r.email);

test('parseSuffixes: case, leading dot, spaces and a trailing comma are tolerated; junk is not', () => {
  assert.deepEqual(parseSuffixes('.COM, net,.gov.au,', 'include-suffix'), ['com', 'net', 'gov.au']);
  assert.throws(() => parseSuffixes('.com,@evil', 'include-suffix'), /not a domain suffix/);
  assert.throws(() => parseSuffixes('a..b', 'exclude-suffix'), /not a domain suffix/);
});

test('parseArgs reads --x=a,b, --x a,b and --x[a,b], and repeated flags add up', () => {
  for (const argv of [['--include-suffix=.com,.net'], ['--include-suffix', '.com,.net'], ['--include-suffix[.com,.net,]']]) {
    assert.deepEqual(suffixFilter(parseArgs(argv)), { include: ['com', 'net'], exclude: [] }, argv.join(' '));
  }
  const both = suffixFilter(parseArgs(['--include-suffix=.au', '--exclude-suffix[.gov.au]', '--include-suffix=.nz', 'x.csv']))!;
  assert.deepEqual(both, { include: ['au', 'nz'], exclude: ['gov.au'] });
  assert.deepEqual(parseArgs(['--include-suffix=.au', 'x.csv']).files, ['x.csv']);
  assert.equal(suffixFilter(parseArgs(['--force'])), null);
  assert.throws(() => parseArgs(['--include-suffix']), /needs a list/);
  assert.throws(() => parseArgs(['--exclude-suffix=,']), /at least one suffix/);
});

test('the country filters are not options', () => {
  assert.throws(() => parseArgs(['--include-country=.au']), /Unknown option/);
});

test('matchesSuffix works on whole labels: .au matches x.com.au, not x.nau; .gov does not match x.gov.au', () => {
  assert.ok(matchesSuffix('x.com.au', 'au'));
  assert.ok(matchesSuffix('au', 'au'));
  assert.ok(!matchesSuffix('x.nau', 'au'));
  assert.ok(!matchesSuffix('x.gov.au', 'gov'));
  assert.ok(matchesSuffix('health.gov.au', 'gov.au'));
  assert.ok(matchesSuffix('health.gov', 'gov'));
});

test('keepEmail: include only, exclude only, both; generic .com addresses are plain suffixes', () => {
  const inc = { include: ['com', 'net', 'au'], exclude: [] };
  assert.deepEqual(['a@x.com', 'a@x.com.au', 'a@x.de', 'a@x.org'].filter((e) => keepEmail(e, inc)), ['a@x.com', 'a@x.com.au']);
  const exc = { include: [], exclude: ['gov', 'edu', 'de'] };
  assert.deepEqual(['a@x.com', 'a@x.gov', 'a@x.de', 'a@x.gov.au', 'a@Y.EDU'].filter((e) => keepEmail(e, exc)), ['a@x.com', 'a@x.gov.au']);
  const both = { include: ['au'], exclude: ['gov.au'] };
  assert.deepEqual(['a@x.com.au', 'a@x.gov.au', 'a@x.com'].filter((e) => keepEmail(e, both)), ['a@x.com.au']);
});

test('filterTag and describeFilter ignore order and duplicates', () => {
  assert.equal(filterTag({ include: ['net', 'com', 'com'], exclude: [] }), 'include-suffix-com-net');
  assert.equal(filterTag({ include: ['au'], exclude: ['gov.au', 'edu'] }), 'include-suffix-au_exclude-suffix-edu-gov.au');
  assert.equal(describeFilter({ include: ['nz', 'au'], exclude: ['gov.au'] }), 'include .au, .nz; exclude .gov.au');
});

test('filterRows counts what it dropped per domain ending', () => {
  const rows = [['A', 'a@x.com', '', ''], ['B', 'b@y.gov.au', '', ''], ['C', 'c@z.gov.au', '', ''], ['D', 'd@q.de', '', '']] as [string, string, string, string][];
  const { kept, dropped } = filterRows(rows, { include: [], exclude: ['gov.au', 'de'] });
  assert.deepEqual(kept.map((r) => r[1]), ['a@x.com']);
  assert.deepEqual(Object.fromEntries(dropped), { 'gov.au': 2, de: 1 });
});

test('every list flag is documented in --help', () => {
  for (const f of LIST_FLAGS) assert.match(USAGE, new RegExp(`--${f}\\b`), f);
});

function setup() {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'name,website\nAlpha,a.com.au\nBeta,b.com\n');
  const out = path.join(dir, 'results');
  const layout = fileLayout('dealers', 'list', out);
  const db = new Db(out);
  const who = { cat: 'dealers', list: 'list', generation: 1, run: 'test' };
  db.sites.append(who, site('https://a.com.au/', ['sales@a.com.au', 'info@health.gov.au']));
  db.sites.append(who, site('https://b.com/', ['hi@b.com', 'x@b.de']));
  const opts = { ...DEFAULT_OPTIONS, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
  return { dir, input, layout, opts, db, who, out };
}

test('processFile --summary-only with a filter: full CSV, filtered CSV, and a history entry', async () => {
  const { input, layout, opts, db } = setup();
  const filter = { include: [], exclude: ['gov.au', 'de'] };
  await processFile(db, input, layout, { ...opts, filter }, null, true);
  assert.deepEqual(readCsv(layout.outFile), ['sales@a.com.au', 'info@health.gov.au', 'hi@b.com', 'x@b.de']);
  const filtered = filteredPath(layout, filter);
  assert.equal(path.dirname(filtered), path.join(layout.emailsDir, 'filtered'));
  assert.deepEqual(readCsv(filtered), ['sales@a.com.au', 'hi@b.com']);
  const events: Record<string, string>[] = [];
  db.runs.scan((e) => { if (e.type === 'filter.end') events.push(e as Record<string, string>); });
  assert.equal(events.length, 1);
  const log = events[0].text;
  assert.match(log, /filtered \(exclude \.de, \.gov\.au\)/);
  assert.match(log, /Emails {3}: 2 of 4 kept/);
  assert.match(log, /Dropped {2}: 2 \(/);
  db.close();
});

test('filterFile writes only the filtered CSV from the stored results, leaving the normal CSV alone', async () => {
  const { input, layout, opts, db, out } = setup();
  fs.mkdirSync(layout.emailsDir, { recursive: true });
  fs.writeFileSync(layout.outFile, 'name,email,website,link\nOld,old@a.com.au,https://a.com.au/,l\n');
  const filter = { include: ['au'], exclude: [] };
  await filterFile(db, input, layout, { ...opts, filter });
  assert.equal(fs.readFileSync(layout.outFile, 'utf8'), 'name,email,website,link\nOld,old@a.com.au,https://a.com.au/,l\n');
  assert.deepEqual(readCsv(filteredPath(layout, filter)), ['sales@a.com.au', 'info@health.gov.au']);
  assert.ok(!fs.existsSync(db.listLockFile('dealers', 'list')), 'the list lock is released');
  db.close();
  assert.ok(out);
});

test('filterFile skips a list with no stored results or an interrupted scrape', async () => {
  const { input, layout, opts, db, who } = setup();
  const filter = { include: ['au'], exclude: [] };
  db.runs.append({ type: 'list.start', run: 'test', cat: 'dealers', list: 'list', generation: 1 });
  await filterFile(db, input, layout, { ...opts, filter });
  assert.ok(!fs.existsSync(filteredPath(layout, filter)), 'interrupted');
  db.runs.append({ type: 'list.end', run: 'test', cat: 'dealers', list: 'list', generation: 1 });
  db.sites.drop(who, 'https://a.com.au/');
  db.sites.drop(who, 'https://b.com/');
  await filterFile(db, input, layout, { ...opts, filter });
  assert.ok(!fs.existsSync(filteredPath(layout, filter)), 'nothing stored');
  db.close();
});

test('writeUnique with a filter also writes unique/<label>.<tag>.csv', () => {
  const out = path.join(tmp(), 'results');
  const a = fileLayout('dealers', 'a', out);
  const b = fileLayout('dealers', 'b', out);
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(a.outFile, 'name,email,website,link\nA,sales@a.com.au,https://a.com.au/,l\nG,x@health.gov.au,https://a.com.au/,l\n');
  put(b.outFile, 'name,email,website,link\nB,x@health.gov.au,https://b.com.au/,l\nC,help@b.de,https://b.com.au/,l\n');
  const target = path.join(a.uniqueDir, 'dealers.csv');
  const filter = { include: [], exclude: ['gov.au', 'de'] };
  const db = new Db(out);
  writeUnique(db, [{ id: 'a', file: a.outFile }, { id: 'b', file: b.outFile }], 'dealers', target, 'dealers', filter);
  assert.deepEqual(readCsv(target), ['sales@a.com.au', 'x@health.gov.au', 'help@b.de']);
  assert.deepEqual(readCsv(path.join(a.uniqueDir, 'dealers.exclude-suffix-de-gov.au.csv')), ['sales@a.com.au']);
  const texts: string[] = [];
  db.runs.scan((e) => { if (e.type === 'unique.end') texts.push(String(e.text)); });
  assert.match(texts[0], /unique dealers filtered \(exclude \.de, \.gov\.au\)/);
  db.close();
});

test('--dry-run names the filtered CSV', () => {
  const { input, layout, db } = setup();
  const filter = { include: ['au'], exclude: [] };
  const text = previewFile(db, input, layout, null, true, false, filter);
  assert.match(text, /then would write the filtered CSV .*filtered.*list\.include-suffix-au\.csv/);
  assert.doesNotMatch(previewFile(db, input, layout, null, true, false), /filtered CSV/);
  db.close();
});
