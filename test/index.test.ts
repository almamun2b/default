import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import os from 'node:os';
import path from 'node:path';
import { budgetRetry, cappedRetry, failedRetry, planRetries, rateLimitedRetry } from '../src/cache.js';
import { ensureTrailingNewline } from '../src/db/jsonl.js';
import { acquireLock, LockedError, writeFileAtomic } from '../src/db/lock.js';
import { Db } from '../src/db/open.js';
import { BOOLEAN_FLAGS, DEFAULT_REVALIDATE_DAYS, INTEGER_FLAGS, NUMBER_FLAGS, OPTIONAL_NUMBER_FLAGS, parseArgs, rawFlag, retryOptions, skipReason, STRING_FLAGS, USAGE } from '../src/cli.js';
import { setMxResolver, undeliverable } from '../src/mx.js';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { assignRows, recheckSite, safeCell, uniqueLabel, uniqueRows } from '../src/output.js';
import { categoryOf, fileLayout, findInputs, findOutputs, groupOf } from '../src/paths.js';
import { previewFile, processFile, staleState, writeUnique } from '../src/run.js';
import { DEFAULT_OPTIONS } from '../src/crawler.js';
import { page, startServer } from './helpers/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
const site = (s: string, extra: Partial<SiteResult> = {}): SiteResult => ({
  site: s, finalUrl: s, business: 'Biz', emails: [], pages: 1, usedBrowser: false, ...extra,
});

// ---------- CLI (L1) ----------

test('skipReason: named files get the same treatment as a plain run', () => {
  const base = { force: false, newOnly: false, retry: false, summaryOnly: false, hasOutput: false, interrupted: false };
  assert.equal(skipReason({ ...base, hasOutput: true }), 'finished'); // finished list: its cache is never rotated away
  assert.equal(skipReason({ ...base, hasOutput: true, force: true }), null);
  assert.equal(skipReason({ ...base, hasOutput: true, newOnly: true }), null);
  assert.equal(skipReason({ ...base, hasOutput: true, summaryOnly: true }), null);
  assert.equal(skipReason({ ...base, hasOutput: true, retry: true }), null);
  assert.equal(skipReason({ ...base, hasOutput: true, interrupted: true }), null); // resumes
  assert.equal(skipReason(base), null); // never scraped: scrape it
  assert.equal(skipReason({ ...base, retry: true }), 'no-output-to-retry');
});

test('parseArgs accepts valid flags in both forms', () => {
  const a = parseArgs(['--force', '--max-pages=10', '--budget', '2.5', '--log-level=debug', 'x.csv']);
  assert.ok(a.flags.has('force'));
  assert.equal(a.values.get('max-pages'), 10);
  assert.equal(a.values.get('budget'), 2.5);
  assert.equal(a.strings.get('log-level'), 'debug');
  assert.deepEqual(a.files, ['x.csv']);
});

test('parseArgs accepts --new-only and it takes no value', () => {
  assert.ok(parseArgs(['--new-only', 'x.csv']).flags.has('new-only'));
  assert.throws(() => parseArgs(['--new-only=1']), /takes no value/);
});

test('parseArgs rejects values on boolean flags, fractions on counts, unknown flags (L1)', () => {
  assert.throws(() => parseArgs(['--force=false']), /takes no value/);
  assert.throws(() => parseArgs(['--quick=0']), /takes no value/);
  assert.throws(() => parseArgs(['--page-concurrency=2.5']), /whole number/);
  assert.throws(() => parseArgs(['--host-concurrency', '1.5']), /whole number/);
  assert.throws(() => parseArgs(['--max-pages']), /whole number/);
  assert.throws(() => parseArgs(['--budget=-1']), /number/);
  assert.throws(() => parseArgs(['--frobnicate']), /Unknown option/);
});

test('--retry-budget-queued takes minutes as --x=N, --x N, or none; a file after it stays a file', () => {
  const alone = parseArgs(['--retry-budget-queued', 'websites/a.csv']);
  assert.ok(alone.flags.has('retry-budget-queued'));
  assert.equal(alone.values.get('retry-budget-queued'), undefined);
  assert.deepEqual(alone.files, ['websites/a.csv']);
  assert.equal(parseArgs(['--retry-budget-queued=60']).values.get('retry-budget-queued'), 60);
  const spaced = parseArgs(['--retry-budget-queued', '7.5', 'a.csv']);
  assert.equal(spaced.values.get('retry-budget-queued'), 7.5);
  assert.deepEqual(spaced.files, ['a.csv']);
  assert.throws(() => parseArgs(['--retry-budget-queued=0']), /minutes > 0/);
  assert.throws(() => parseArgs(['--retry-budget-queued=abc']), /minutes > 0/);
  assert.ok(parseArgs(['--retry-rate-limited']).flags.has('retry-rate-limited'));
  assert.throws(() => parseArgs(['--retry-rate-limited=1']), /takes no value/);
});

test('retryOptions: the three retries are independent, and the budget is given once', () => {
  assert.deepEqual(retryOptions(parseArgs(['--retry-failed', '--retry-rate-limited'])), { failed: true, rateLimited: true, budget: false, capped: false, budgetMin: undefined });
  assert.deepEqual(retryOptions(parseArgs(['--retry-budget-queued=45'])), { failed: false, rateLimited: false, budget: true, capped: false, budgetMin: 45 });
  assert.equal(retryOptions(parseArgs(['--retry-budget-queued', '--budget=30'])).budgetMin, undefined);
  assert.throws(() => retryOptions(parseArgs(['--retry-budget-queued=60', '--budget=30'])), /give it once/);
});

test('--revalidate takes days as --x=N, --x N, or none; a file after it stays a file', () => {
  const alone = parseArgs(['--revalidate', 'websites/a.csv']);
  assert.ok(alone.flags.has('revalidate'));
  assert.equal(alone.values.get('revalidate'), undefined);
  assert.deepEqual(alone.files, ['websites/a.csv']);
  assert.equal(parseArgs(['--revalidate=7']).values.get('revalidate'), 7);
  assert.equal(parseArgs(['--revalidate=0']).values.get('revalidate'), 0);
  assert.equal(parseArgs(['--revalidate', '0.5', 'a.csv']).values.get('revalidate'), 0.5);
  assert.ok(!parseArgs(['a.csv']).flags.has('revalidate'));
  assert.throws(() => parseArgs(['--revalidate=-1']), /days ≥ 0/);
  assert.throws(() => parseArgs(['--revalidate=abc']), /days ≥ 0/);
  assert.equal(DEFAULT_REVALIDATE_DAYS, 30);
});

test('rawFlag reads a flag before validation', () => {
  assert.equal(rawFlag(['--log-level', 'warn', '--bogus'], 'log-level'), 'warn');
  assert.equal(rawFlag(['--log-level=error'], 'log-level'), 'error');
  assert.equal(rawFlag(['--force'], 'log-level'), undefined);
});

// ---------- input (M12, L14) ----------

function csv(text: string): string {
  const f = path.join(tmp(), 'in.csv');
  fs.writeFileSync(f, text);
  return f;
}

test('readSites: exact header', () => {
  const r = readSites(csv('name,website\nA,a.co.nz\nB,https://b.co.nz/\n'));
  assert.deepEqual(r.sites, ['https://a.co.nz/', 'https://b.co.nz/']);
});

test("readSites: the input's name column is read per site", () => {
  const r = readSites(csv('website,name\na.co.nz,  Acme   Dental \nb.co.nz,\n'));
  assert.deepEqual([...r.names], [['https://a.co.nz/', 'Acme Dental']]);
  assert.deepEqual([...readSites(csv('Business Name,Website\nAcme,a.co.nz\n')).names], [['https://a.co.nz/', 'Acme']]);
  assert.equal(readSites(csv('a.co.nz,Acme\n')).names.size, 0); // no header row, no name column
});

test('readSites: fuzzy header such as "Company Website" (M12)', () => {
  const r = readSites(csv('Company Name,Company Website\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
});

test('readSites: unrecognised header picks the URL-like column and skips the header row (M12)', () => {
  const r = readSites(csv('Business,Web\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
  const r2 = readSites(csv('Business,Homepage\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r2.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
  assert.equal(r2.header, true);
});

test('readSites: headerless file keeps the first row', () => {
  assert.deepEqual(readSites(csv('a.co.nz\nb.co.nz\n')).sites, ['https://a.co.nz/', 'https://b.co.nz/']);
});

test('readSites: counts invalid and duplicate rows; query strings stay distinct (L14)', () => {
  const r = readSites(csv('website\na.co.nz\nwww.a.co.nz/\nnot a url\ng.nz/d?id=1\ng.nz/d?id=2\n'));
  assert.deepEqual(r.sites, ['https://a.co.nz/', 'https://g.nz/d?id=1', 'https://g.nz/d?id=2']);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
});

// ---------- stored results (H3, M10, M11) ----------

test('ensureTrailingNewline keeps the next append on its own line', () => {
  const file = path.join(tmp(), 'x.jsonl');
  ensureTrailingNewline(file); // missing file: no-op
  assert.ok(!fs.existsSync(file));
  fs.writeFileSync(file, '');
  ensureTrailingNewline(file);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  const a = JSON.stringify(site('https://a.nz/'));
  fs.writeFileSync(file, a); // cut off before its newline
  ensureTrailingNewline(file);
  ensureTrailingNewline(file); // already ends in \n: no-op
  fs.appendFileSync(file, JSON.stringify(site('https://b.nz/')) + '\n');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('retry predicates: failures, rate-limited pages and time-budget queues; never robots blocks (M10)', () => {
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const resume = (extra = {}) => ({ queued: [], limited: [], attempts: 5, ...extra });
  assert.equal(failedRetry(site('a', { error: 'unreachable' })), true);
  assert.equal(failedRetry(site('a', { error: 'robots-disallowed' })), false);
  assert.equal(failedRetry(site('a', { error: 'timeout', emails })), false);
  assert.equal(failedRetry(site('a', { emails, rateLimited: 3 })), false); // rate limiting is its own retry now
  assert.equal(rateLimitedRetry(site('a', { emails, rateLimited: 3 })), true); // pre-v3 row: only a count
  assert.equal(rateLimitedRetry(site('a', { v: 3, emails, rateLimited: 1 })), false); // v3, but no page of its own was skipped
  assert.equal(rateLimitedRetry(site('a', { v: 3, emails, rateLimited: 1, resume: resume({ limited: [['https://a/x', 2]] }) })), true);
  assert.equal(rateLimitedRetry(site('a', { error: 'robots-disallowed', rateLimited: 1 })), false);
  assert.equal(budgetRetry(site('a', { emails, budgetQueued: 40 })), true); // marked from the logs
  assert.equal(budgetRetry(site('a', { v: 3, resume: resume({ browser: 'no-emails' }) })), true);
  assert.equal(budgetRetry(site('a', { v: 3, emails })), false);
  assert.equal(budgetRetry(site('a', { error: 'robots-disallowed', budgetQueued: 3 })), false);
});

test('planRetries: saved state is continued, rows without it are crawled again keeping the old row', () => {
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const st = { queued: [['https://n.nz/q', 2]] as [string, number][], limited: [['https://n.nz/l', 2]] as [string, number][], attempts: 9 };
  const done = new Map<string, SiteResult>([
    ['f', site('f', { error: 'unreachable' })],
    ['old', site('old', { emails, budgetQueued: 50, rateLimited: 2 })],
    ['new', site('new', { v: 3, emails, budgetQueued: 50, rateLimited: 1, resume: st })],
    ['ok', site('ok', { v: 3, emails })],
    ['rb', site('rb', { error: 'robots-disallowed', budgetQueued: 1 })],
  ]);
  const all = planRetries(done, { failed: true, rateLimited: true, budget: true });
  assert.deepEqual([...all.recrawl].sort(), ['f', 'old']);
  assert.deepEqual([...all.previous.keys()], ['old']);
  assert.deepEqual(Object.fromEntries(all.resume), { new: { budget: true, limited: true, capped: false } });

  const budgetOnly = planRetries(done, { failed: false, rateLimited: false, budget: true });
  assert.deepEqual([...budgetOnly.recrawl], ['old']);
  assert.deepEqual(Object.fromEntries(budgetOnly.resume), { new: { budget: true, limited: false, capped: false } });

  const limitedOnly = planRetries(done, { failed: false, rateLimited: true, budget: false });
  assert.deepEqual(Object.fromEntries(limitedOnly.resume), { new: { budget: false, limited: true, capped: false } });
  // a v3 row with only rate-limited pages left is not picked by the budget retry
  assert.equal(planRetries(new Map([['x', site('x', { v: 3, emails, resume: { ...st, queued: [] } })]]), { failed: false, rateLimited: false, budget: true }).resume.size, 0);
});

test('acquireLock refuses a live holder and takes over a stale one (M11)', () => {
  const lock = path.join(tmp(), 'x.lock');
  fs.writeFileSync(lock, String(process.ppid)); // a live process that isn't us
  assert.throws(() => acquireLock(lock), LockedError);
  fs.writeFileSync(lock, '999999999'); // no such pid
  const release = acquireLock(lock);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  release();
  assert.ok(!fs.existsSync(lock));
});

// ---------- output (M7) ----------

test('safeCell neutralises formulas (M7)', () => {
  assert.equal(safeCell('=HYPERLINK("http://evil","x")'), `'=HYPERLINK("http://evil","x")`);
  assert.equal(safeCell('+64 9 123'), "'+64 9 123");
  assert.equal(safeCell('@home'), "'@home");
  assert.equal(safeCell('Acme Dental'), 'Acme Dental');
});

test('assignRows: input order, unique by email, name fallback, formula-safe', () => {
  const done = new Map<string, SiteResult>([
    ['https://a.nz/', site('https://a.nz/', { business: '=evil()', emails: [{ email: 'x@a.nz', name: null, link: 'l1' }] })],
    ['https://b.nz/', site('https://b.nz/', { emails: [{ email: 'x@a.nz', name: 'Jo Bloggs', link: 'l2' }, { email: 'y@b.nz', name: null, link: 'l3', pageTitle: 'Cardiology' }] })],
  ]);
  const out = assignRows(['https://a.nz/', 'https://b.nz/', 'https://c.nz/'], done);
  assert.deepEqual(out.rows, [
    ["'=evil()", 'x@a.nz', 'https://a.nz/', 'l1'],
    ['Cardiology', 'y@b.nz', 'https://b.nz/', 'l3'],
  ]);
  assert.deepEqual(out.kinds, { person: 0, department: 1, input: 0, business: 1 });
});

test('assignRows credits an email to the site that owns its domain, not the first one listing it (B4)', () => {
  const sites = ['https://www.bydhaberfield.com.au/', 'https://bydcastlehill.com.au/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { business: 'BYD Haberfield', emails: [
      { email: 'sales@bydcastlehill.com.au', name: null, link: 'h1', source: 'raw' },
      { email: 'sales@bydhaberfield.com.au', name: null, link: 'h2', source: 'mailto' },
    ] })],
    [sites[1], site(sites[1], { business: 'BYD Castle Hill', emails: [{ email: 'sales@bydcastlehill.com.au', name: null, link: 'c1', source: 'mailto' }] })],
  ]);
  assert.deepEqual(assignRows(sites, done).rows, [
    ['BYD Haberfield', 'sales@bydhaberfield.com.au', sites[0], 'h2'],
    ['BYD Castle Hill', 'sales@bydcastlehill.com.au', sites[1], 'c1'],
  ]);
});

test('assignRows prefers a site where the email was not only in raw HTML (B4)', () => {
  const sites = ['https://a.com.au/', 'https://b.com.au/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { emails: [{ email: 'jo@gmail.com', name: null, link: 'a', source: 'raw' }] })],
    [sites[1], site(sites[1], { emails: [{ email: 'jo@gmail.com', name: null, link: 'b', source: 'mailto' }] })],
  ]);
  assert.equal(assignRows(sites, done).rows[0][2], sites[1]);
});

test('assignRows keeps an email found on many sites that none of them owns in the main rows, credited to the first', () => {
  const dealer = (host: string) => site(`https://${host}/`, { business: host, emails: [
    { email: 'enquiries@oaic.gov.au', name: null, link: `https://${host}/privacy` },
    { email: `sales@${host}`, name: null, link: `https://${host}/` },
  ] });
  const sites = ['https://a.com.au/', 'https://b.com.au/', 'https://c.com.au/'];
  const done = new Map(sites.map((s) => [s, dealer(new URL(s).hostname)]));
  const out = assignRows(sites, done);
  assert.deepEqual(out.rows, [
    ['a.com.au', 'enquiries@oaic.gov.au', 'https://a.com.au/', 'https://a.com.au/privacy'],
    ['a.com.au', 'sales@a.com.au', 'https://a.com.au/', 'https://a.com.au/'],
    ['b.com.au', 'sales@b.com.au', 'https://b.com.au/', 'https://b.com.au/'],
    ['c.com.au', 'sales@c.com.au', 'https://c.com.au/', 'https://c.com.au/'],
  ]);
  assert.ok(!('shared' in out));
});

test("assignRows uses the input's own name before the scraped business name, after person and department names", () => {
  const sites = ['https://a.nz/', 'https://b.nz/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { business: 'Home', emails: [{ email: 'info@a.nz', name: null, link: 'l' }, { email: 'jo@a.nz', name: 'Jo Bloggs', link: 'l' }] })],
    [sites[1], site(sites[1], { business: 'B Ltd', emails: [{ email: 'info@b.nz', name: null, link: 'l', pageTitle: 'Cardiology' }] })],
  ]);
  const out = assignRows(sites, done, new Map([[sites[0], 'St Mary’s Church'], [sites[1], 'B Clinic']]));
  assert.deepEqual(out.rows.map((r) => r[0]), ['St Mary’s Church', 'Jo Bloggs', 'Cardiology']);
  assert.deepEqual(out.kinds, { person: 1, department: 1, input: 1, business: 0 });
});

test('recheckSite tidies cached business names and drops generic department titles (D3)', () => {
  const r = recheckSite(site('https://www.acme.co.nz/', { finalUrl: 'https://www.acme.co.nz/', business: 'Home', emails: [{ email: 'info@acme.co.nz', name: null, link: 'l', pageTitle: 'Contact Us' }] }));
  assert.equal(r.business, 'acme.co.nz');
  assert.equal(r.emails[0].pageTitle, undefined);
  assert.equal(recheckSite(site('https://x.nz/', { business: 'Welcome to The Denture Place' })).business, 'The Denture Place');
});

// ---------- --unique ----------

test('parseArgs accepts --unique', () => {
  assert.ok(parseArgs(['--unique', 'websites/au.a.csv']).flags.has('unique'));
  assert.throws(() => parseArgs(['--unique=1']), /takes no value/);
});

test('uniqueRows keeps each email once across files, first file wins, case-insensitive', () => {
  const { rows, read, overlaps } = uniqueRows([
    { base: 'au.a', rows: [['A', 'x@a.com', 'https://a.com/', ''], ['B', 'y@a.com', 'https://a.com/', '']] },
    { base: 'au.b', rows: [['Other', 'X@A.com ', 'https://b.com/', ''], ['C', 'z@b.com', 'https://b.com/', '']] },
    { base: 'au.c', rows: [['D', 'y@a.com', 'https://c.com/', ''], ['E', 'z@b.com', 'https://c.com/', '']] },
  ]);
  assert.equal(read, 6);
  assert.deepEqual(rows.map((r) => [r[0], r[1]]), [['A', 'x@a.com'], ['B', 'y@a.com'], ['C', 'z@b.com']]);
  assert.deepEqual(Object.fromEntries(overlaps), { 'au.b ← au.a': 1, 'au.c ← au.a': 1, 'au.c ← au.b': 1 });
});

test('writeUnique combines the output CSVs into emails/<category>/unique/, first file wins, and records it in the run history', () => {
  const out = path.join(tmp(), 'results');
  const a = fileLayout('dealers', 'a', out);
  const b = fileLayout('dealers', 'b', out);
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(a.outFile, 'name,email,website,link\nA,sales@a.com.au,https://a.com.au/,l\nY,info@b.com.au,https://a.com.au/,l\n');
  put(b.outFile, 'name,email,website,link\nB,info@b.com.au,https://b.com.au/,l\nC,help@b.com.au,https://b.com.au/,l\n');
  const target = path.join(a.uniqueDir, 'dealers.csv');
  assert.equal(path.dirname(target), path.join(out, 'emails', 'dealers', 'unique'));
  const db = new Db(out);
  writeUnique(db, [{ id: 'a', file: a.outFile }, { id: 'b', file: b.outFile }], 'dealers', target, 'dealers');
  const rows = parse(fs.readFileSync(target, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((r) => [r.name, r.email, r.website]), [
    ['A', 'sales@a.com.au', 'https://a.com.au/'],
    ['Y', 'info@b.com.au', 'https://a.com.au/'],
    ['C', 'help@b.com.au', 'https://b.com.au/'],
  ]);
  const events: Record<string, string>[] = [];
  db.runs.scan((e) => events.push(e as Record<string, string>));
  const summary = events.find((e) => e.t === 'unique.end')!.text;
  assert.doesNotMatch(summary, /Shared/);
  assert.match(summary, /Rows {5}: 4 read, 1 duplicate\(s\) removed/);
  db.close();
});

test('uniqueLabel names the combined file after the shared prefix', () => {
  assert.equal(uniqueLabel(['au.ford', 'au.kia']), 'au');
  assert.equal(uniqueLabel(['nz_dentists_all', 'nz_hospitals_all']), 'nz');
  assert.equal(uniqueLabel(['au.ford', 'nz_dentists_all']), 'all');
  assert.equal(uniqueLabel(['clinics']), 'clinics');
});

// ---------- category folders ----------

const IN = path.join(path.sep, 'p', 'websites');
const OUT = path.join(path.sep, 'p', 'results');

test('groupOf: category folder, else the file name; outputs map back to the same group', () => {
  assert.equal(groupOf(path.join(IN, 'dealers', 'au.ford.csv'), IN, OUT), 'dealers');
  assert.equal(groupOf(path.join(IN, 'clinics.csv'), IN, OUT), 'clinics');
  assert.equal(groupOf(path.join(path.sep, 'elsewhere', 'sample.csv'), IN, OUT), 'sample');
  assert.equal(groupOf(path.join(OUT, 'emails', 'dealers', 'au.ford.csv'), IN, OUT), 'dealers');
  assert.equal(groupOf(path.join(IN, 'a', 'b', 'x.csv'), IN, OUT), 'x'); // only one level of category
  assert.equal(categoryOf(path.join(IN, 'clinics.csv'), IN, OUT), undefined);
});

test('fileLayout puts output, filtered and unique CSVs in results/emails/<category>/, and nothing else', () => {
  const l = fileLayout('dealers', 'au.ford', OUT);
  assert.equal(l.id, 'dealers/au.ford');
  assert.equal(l.outFile, path.join(OUT, 'emails', 'dealers', 'au.ford.csv'));
  assert.equal(l.filteredDir, path.join(OUT, 'emails', 'dealers', 'filtered'));
  assert.equal(l.uniqueDir, path.join(OUT, 'emails', 'dealers', 'unique'));
  assert.deepEqual(Object.keys(l).sort(), ['base', 'emailsDir', 'filteredDir', 'group', 'id', 'outFile', 'uniqueDir'], 'no cache or log folders any more');
  for (const reserved of ['db', 'emails', 'unique']) assert.throws(() => fileLayout(reserved, 'x', OUT), /reserved/);
});

test('findInputs and findOutputs walk one level of category folders', () => {
  const d = tmp();
  const put = (...p: string[]) => { fs.mkdirSync(path.dirname(path.join(d, ...p)), { recursive: true }); fs.writeFileSync(path.join(d, ...p), 'x'); };
  put('top.csv'); put('dealers', 'a.csv'); put('dealers', 'notes.txt'); put('dealers', 'deep', 'z.csv'); put('.hidden', 'h.csv');
  assert.deepEqual(findInputs(d).map((f) => path.relative(d, f)), [path.join('dealers', 'a.csv'), 'top.csv']);
  put('emails', 'dealers', 'a.csv'); put('emails', 'dealers', 'unique', 'dealers.csv'); put('emails', 'dealers', 'filtered', 'a.com.csv'); put('emails', 'unique', 'u.csv'); put('emails', '.hidden', 'h.csv'); put('dealers', 'top-level-ignored.csv'); put('db', 'pages.csv');
  assert.deepEqual([...findOutputs(d)].map(([g, f]) => [g, f.map((x) => path.basename(x))]), [['dealers', ['a.csv']]]);
});

// ---------- audit 2026-10-13 ----------

test('--budget must be more than 0 minutes (B13)', () => {
  assert.throws(() => parseArgs(['--budget=0']), /minutes > 0/);
  assert.equal(parseArgs(['--budget=0.5']).values.get('budget'), 0.5);
});

test('readSites reads UTF-16 files saved by Excel, and names the line of a broken CSV (B10)', () => {
  const dir = tmp();
  const utf16 = path.join(dir, 'u.csv');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tWebsite\r\nAcme\tacme.co.nz\r\n', 'utf16le')]));
  assert.deepEqual(readSites(utf16).sites, ['https://acme.co.nz/']);
  assert.deepEqual([...readSites(utf16).names], [['https://acme.co.nz/', 'Acme']]);
  assert.deepEqual(readSites(csv('name,website\nBob\'s "best" shop,a.co.nz\n')).sites, ['https://a.co.nz/']); // a stray quote inside a field is fine
  assert.throws(() => readSites(csv('website\na.co.nz\n"b.co.nz" x\n')), /not a readable CSV \(near line 3\)/);
});

test('writeFileAtomic creates files readable by their owner only, and keeps an existing mode (S4)', () => {
  const f = path.join(tmp(), 'x.csv');
  writeFileAtomic(f, 'a');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.chmodSync(f, 0o644);
  writeFileAtomic(f, 'b');
  assert.equal(fs.statSync(f).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b');
});

test('processFile --summary-only: credited rows, input names and failure details', async () => {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'name,website\nAlpha Motors,a.com.au\nBeta Motors,b.com.au\nGamma Motors,c.com.au\nDead Motors,dead.com.au\n');
  const out = path.join(dir, 'results');
  const layout = fileLayout('dealers', 'list', out);
  const dealer = (h: string): SiteResult => site(`https://${h}/`, { business: 'Home', emails: [
    { email: 'complaints@myfordfinance.com.au', name: null, link: `https://${h}/privacy` },
    { email: `sales@${h}`, name: null, link: `https://${h}/contact` },
  ] });
  const db = new Db(out);
  const who = { cat: 'dealers', list: 'list', g: 1, run: 'test' };
  for (const r of [dealer('a.com.au'), dealer('b.com.au'), dealer('c.com.au'), site('https://dead.com.au/', { pages: 0, error: 'unreachable', errorDetail: 'dns' })]) db.sites.append(who, r);
  const opts = { ...DEFAULT_OPTIONS, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
  await processFile(db, input, layout, opts, null, true);
  const rows = parse(fs.readFileSync(layout.outFile, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((r) => [r.name, r.email]), [
    ['Alpha Motors', 'complaints@myfordfinance.com.au'], ['Alpha Motors', 'sales@a.com.au'], ['Beta Motors', 'sales@b.com.au'], ['Gamma Motors', 'sales@c.com.au'],
  ]);
  assert.deepEqual(fs.readdirSync(out).sort(), ['db', 'emails'], 'only the database and the output tree, no cache or log folders');
  const end = [] as Record<string, any>[];
  db.runs.scan((e) => { if (e.t === 'list.end') end.push(e); });
  assert.equal(end.length, 1);
  assert.equal(end[0].list, 'list');
  assert.equal(end[0].counts.uniqueEmails, 4);
  assert.match(end[0].text, /4 unique \(0 person name, 0 department page title, 4 input name, 0 business name\)/);
  assert.doesNotMatch(end[0].text, /Shared/);
  assert.match(end[0].text, /Failures : unreachable=1 \(dns=1\)/);
  assert.match(end[0].text, /dead\.com\.au \[unreachable: dns\]/);
  db.close();
});

test('--retry-capped needs a higher --max-pages, and picks only rows stopped by the page cap (F4)', () => {
  assert.throws(() => retryOptions(parseArgs(['--retry-capped'])), /--max-pages/);
  assert.equal(retryOptions(parseArgs(['--retry-capped', '--max-pages=800'])).capped, true);
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const capped = site('c', { v: 3, emails, capQueued: 30, resume: { queued: [['https://c/q', 2]], limited: [], attempts: 400, capped: true } });
  const timed = site('t', { v: 3, emails, budgetQueued: 30, resume: { queued: [['https://t/q', 2]], limited: [], attempts: 120 } });
  assert.equal(cappedRetry(capped), true);
  assert.equal(budgetRetry(capped), false, 'more time would not help a capped site');
  assert.equal(cappedRetry(timed), false);
  const done = new Map([['c', capped], ['t', timed]]);
  assert.deepEqual(Object.fromEntries(planRetries(done, { failed: false, rateLimited: false, budget: false, capped: true }).resume), { c: { budget: false, limited: false, capped: true } });
  assert.deepEqual([...planRetries(done, { failed: false, rateLimited: false, budget: true }).resume.keys()], ['t']);
});

test('every command-line flag is documented in --help (F2)', () => {
  for (const f of [...BOOLEAN_FLAGS, ...INTEGER_FLAGS, ...NUMBER_FLAGS, ...OPTIONAL_NUMBER_FLAGS, ...STRING_FLAGS]) assert.match(USAGE, new RegExp(`--${f}\\b`), f);
});

test('--check-mx drops only domains DNS says cannot receive mail (F3)', async () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  setMxResolver({
    resolveMx: async (d) => {
      if (d === 'acme.co.nz') return [{ exchange: 'mx.acme.co.nz', priority: 10 }];
      if (d === 'nullmx.nz') return [{ exchange: '.', priority: 0 }];
      if (d === 'gone.nz') throw err('ENOTFOUND');
      if (d === 'flaky.nz') throw err('ETIMEOUT');
      throw err('ENODATA');
    },
    resolve4: async (d) => { if (d === 'webonly.nz') return ['93.184.216.34']; throw err('ENODATA'); },
    resolve6: async () => { throw err('ENODATA'); },
  });
  try {
    const bad = await undeliverable(['a@acme.co.nz', 'b@nullmx.nz', 'c@gone.nz', 'd@flaky.nz', 'e@webonly.nz', 'f@nothing.nz']);
    assert.deepEqual([...bad].sort(), ['b@nullmx.nz', 'c@gone.nz', 'f@nothing.nz']);
  } finally {
    setMxResolver(null);
  }
});

test('--dry-run describes each file without writing anything (F2)', () => {
  const dir = tmp();
  const input = path.join(dir, 'websites', 'clinics', 'list.csv');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, 'website\na.nz\nb.nz\nc.nz\n');
  const out = path.join(dir, 'results');
  const layout = fileLayout('clinics', 'list', out);
  const writer = new Db(out);
  const who = { cat: 'clinics', list: 'list', g: 1, run: 'test' };
  const db = new Db(out, { readOnly: true });
  assert.equal(previewFile(db, input, layout, null, false), 'clinics/list: would scrape 3 sites');
  writer.sites.append(who, site('https://a.nz/', { emails: [{ email: 'x@a.nz', name: null, link: 'l' }] }));
  writer.sites.append(who, site('https://b.nz/', { error: 'unreachable' }));
  writer.runs.append({ t: 'list.start', run: 'test', cat: 'clinics', list: 'list', g: 1 }); // a run that died before list.end
  assert.match(previewFile(db, input, layout, null, false), /resume an interrupted scrape: 2 of 3 sites stored, 1 to scrape/);
  assert.match(previewFile(db, input, layout, { failed: true, rateLimited: false, budget: false }, false), /re-crawl 1 and continue 0 of 3 sites, and scrape 1 not scraped yet/);
  assert.match(previewFile(db, input, layout, null, true), /interrupted; would be skipped/);
  writer.runs.append({ t: 'list.end', run: 'test', cat: 'clinics', list: 'list', g: 1, status: 'finished' });
  fs.mkdirSync(layout.emailsDir, { recursive: true });
  fs.writeFileSync(layout.outFile, 'name,email,website,link\n');
  assert.match(previewFile(db, input, layout, null, false), /would scrape all 3 sites again/);
  assert.match(previewFile(db, input, layout, null, false, true), /would scrape 1 new sites; 2 stored sites reused/);
  writer.sites.append(who, site('https://c.nz/'));
  assert.match(previewFile(db, input, layout, null, false, true), /nothing new \(all 3 sites stored\)/);
  assert.deepEqual(fs.readdirSync(path.join(out, 'db')).sort(), ['locks', 'manifest.json', 'run-history.jsonl', 'sites.jsonl'], 'the read-only database wrote nothing of its own');

  writer.runs.append({ t: 'list.start', run: 'test', cat: 'clinics', list: 'gone', g: 1 });
  fs.writeFileSync(path.join(writer.files.locksDir, 'clinics.list.lock'), '999999999');
  const stale = staleState(db, [input]);
  assert.equal(stale.length, 2);
  assert.match(stale.join('\n'), /clinics\/gone: an interrupted scrape .* whose input list is gone/);
  assert.match(stale.join('\n'), /clinics\.list\.lock: left by a run that is gone/);
  db.close();
  writer.close();
});

// ---------- pages are scraped once, whatever the category ----------

const listOpts = { ...DEFAULT_OPTIONS, browserPages: 0, budgetMs: 30_000, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
const rowsOf = (file: string) => (parse(fs.readFileSync(file, 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => r.email);
const listEnds = (db: Db) => { const ends: Record<string, any>[] = []; db.runs.scan((e) => { if (e.t === 'list.end') ends.push(e); }); return ends; };

test('every list shares the pages already scraped, in any category', async () => {
  const s = await startServer({
    '/a': page('<a href="/contact">Contact</a>'),
    '/b': page('<a href="/contact">Contact</a>'),
    '/c': page('<a href="/contact?utm_source=x">Contact</a>'),
    '/contact': page('<a href="mailto:info@acme.co.nz">mail</a>'),
  });
  const dir = tmp();
  const out = path.join(dir, 'results');
  let db = new Db(out);
  try {
    const write = (name: string, sites: string[]) => {
      const f = path.join(dir, `${name}.csv`);
      fs.writeFileSync(f, `website\n${sites.map((x) => s.url + x).join('\n')}\n`);
      return f;
    };
    const one = fileLayout('clinics', 'one', out), two = fileLayout('clinics', 'two', out), other = fileLayout('shops', 'one', out);

    await processFile(db, write('one', ['/a']), one, listOpts, null);
    assert.equal(s.hits.filter((h) => h === '/contact').length, 1);
    assert.equal(fs.statSync(db.files.pages).mode & 0o777, 0o600, 'it holds personal data');
    assert.equal(fs.statSync(db.files.sites).mode & 0o777, 0o600);

    // a second list of the category, with a tracking param on the link: nothing is requested for the page again
    await processFile(db, write('two', ['/b', '/c']), two, listOpts, null);
    assert.equal(s.hits.filter((h) => h.startsWith('/contact')).length, 1);
    assert.deepEqual(rowsOf(two.outFile), ['info@acme.co.nz']);
    assert.match(listEnds(db).find((e) => e.list === 'two')!.text, /Crawl {4}: 2 pages fetched \+ 2 reused/);
    db.close();

    // the next run still knows them (a list that grew)
    db = new Db(out);
    await processFile(db, write('two', ['/b', '/c', '/a']), two, listOpts, null, false, true);
    assert.equal(s.hits.filter((h) => h.startsWith('/contact')).length, 1);
    db.close();

    // another category reuses them too: the page is in the one store
    db = new Db(out);
    await processFile(db, write('one', ['/a']), other, listOpts, null);
    assert.equal(s.hits.filter((h) => h === '/contact').length, 1, 'a page is fetched once, whatever the category');
    assert.deepEqual(rowsOf(other.outFile), ['info@acme.co.nz']);
    const stored = db.pages.getRecord('http', new URL(s.url).host + '/contact');
    assert.ok(stored);
    const first = fs.readFileSync(db.files.pages, 'utf8').split('\n').map((l) => l && JSON.parse(l)).find((l) => l.k?.endsWith('/contact'));
    assert.deepEqual([first.cat, first.list, first.site, first.m], ['clinics', 'one', s.url + '/a', 'http'], 'the page says who fetched it');
  } finally {
    db.close();
    await s.close();
  }
});

test('a fresh re-scrape and --revalidate ask for stored pages again, with their validators', async () => {
  const link = page('<a href="/contact">Contact</a>');
  const s = await startServer({
    '/a': link, '/a2': link, '/a3': link,
    '/contact': { body: page('<a href="mailto:info@acme.co.nz">mail</a>'), headers: { etag: '"v1"' } },
  });
  const dir = tmp();
  const out = path.join(dir, 'results');
  let db = new Db(out);
  const reopen = () => { db.close(); db = new Db(out); };
  try {
    const input = path.join(dir, 'list.csv');
    const sites = (n: number) => fs.writeFileSync(input, `website\n${['/a', '/a2', '/a3'].slice(0, n).map((x) => s.url + x).join('\n')}\n`);
    const layout = fileLayout('clinics', 'list', out);
    const asks = () => s.hits.map((h, i) => [h, s.heads[i]['if-none-match']]).filter(([h]) => h === '/contact');

    sites(1);
    await processFile(db, input, layout, listOpts, null);
    reopen();
    sites(2);
    await processFile(db, input, layout, listOpts, null, false, true); // the list grew; the stored page is still fresh
    reopen();
    assert.equal(asks().length, 1);

    sites(3);
    await processFile(db, input, layout, { ...listOpts, revalidateDays: 0 }, null, false, true);
    reopen();
    assert.deepEqual(asks(), [['/contact', undefined], ['/contact', '"v1"']], '--revalidate: asked again, conditionally');

    const sizeBefore = fs.statSync(db.files.pages).size;
    await processFile(db, input, layout, listOpts, null); // output exists, so this is a fresh re-scrape of all three sites
    reopen();
    assert.equal(asks().length, 3, 'a fresh re-scrape asks again, once, and the other sites use that answer');
    assert.ok(fs.statSync(db.files.pages).size > sizeBefore, 'older lines are kept, never rewritten');
    assert.deepEqual(rowsOf(layout.outFile), ['info@acme.co.nz']);
    assert.equal(db.sites.generation('clinics', 'list'), 2, 'the fresh re-scrape is a new generation; the first stays in the file');
    assert.equal(db.sites.loadList('clinics', 'list', 1).size, 3);
  } finally {
    db.close();
    await s.close();
  }
});

test('a run that dies mid-list is resumed by the next one, which scrapes only the sites left', async () => {
  const s = await startServer({ '/a': page('<p>a@acme.co.nz</p>'), '/b': page('<p>b@acme.co.nz</p>'), '/c': page('<p>c@acme.co.nz</p>') });
  const dir = tmp();
  const out = path.join(dir, 'results');
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, `website\n${['/a', '/b', '/c'].map((x) => s.url + x).join('\n')}\n`);
  const layout = fileLayout('clinics', 'list', out);
  try {
    // the first run stored one site, then died: no list.end, no CSV
    let db = new Db(out);
    const begun = db.beginList({ cat: 'clinics', list: 'list', run: 'dead', mode: 'scrape', sites: 3, outputExists: false, keep: false });
    db.sites.append(begun, site(s.url + '/a', { emails: [{ email: 'a@acme.co.nz', name: null, link: s.url + '/a' }] }));
    db.close();

    db = new Db(out);
    assert.ok(db.runs.interrupted('clinics', 'list'));
    assert.match(previewFile(db, input, layout, null, false), /resume an interrupted scrape: 1 of 3 sites stored, 2 to scrape/);
    await processFile(db, input, layout, listOpts, null);
    assert.ok(!db.runs.interrupted('clinics', 'list'), 'now it has ended');
    assert.equal(s.hits.filter((h) => h === '/a').length, 0, 'the stored site was not crawled again');
    assert.deepEqual(rowsOf(layout.outFile).sort(), ['a@acme.co.nz', 'b@acme.co.nz', 'c@acme.co.nz']);
    assert.equal(db.sites.generation('clinics', 'list'), 1);
    assert.equal(listEnds(db).length, 1);
    db.close();
  } finally {
    await s.close();
  }
});

test('a retry drops failed sites it will crawl again, so an interrupted retry still redoes them', async () => {
  const s = await startServer({ '/ok': page('<p>ok@acme.co.nz</p>') });
  const dir = tmp();
  const out = path.join(dir, 'results');
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, `website\n${s.url}/ok\n${s.url}/missing\n`);
  const layout = fileLayout('clinics', 'list', out);
  const db = new Db(out);
  try {
    await processFile(db, input, layout, listOpts, null);
    const g = db.sites.generation('clinics', 'list');
    assert.equal(db.sites.loadList('clinics', 'list', g).size, 2);
    const failed = [...db.sites.loadList('clinics', 'list', g).values()].filter((r) => r.error);
    assert.equal(failed.length, 1, 'the missing page is a failed site');
    await processFile(db, input, layout, listOpts, { failed: true, rateLimited: false, budget: false }, false, false);
    assert.equal(db.sites.generation('clinics', 'list'), g, 'a retry builds on the current generation');
    const end = listEnds(db);
    assert.equal(end.length, 2);
    assert.match(end[1].mode, /retry/);
  } finally {
    db.close();
    await s.close();
  }
});

test('the page store has one writer: a database whose pages are held by another live run is not scraped', async () => {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'website\nhttps://example.com/\n');
  const out = path.join(dir, 'results');
  const layout = fileLayout('clinics', 'list', out);
  const db = new Db(out);
  fs.writeFileSync(path.join(db.files.locksDir, 'pages.lock'), String(process.ppid)); // a live process that is not this one
  try {
    await assert.rejects(processFile(db, input, layout, listOpts, null), LockedError);
  } finally {
    db.close();
  }
});
