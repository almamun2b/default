import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SiteResult } from '../src/crawler.js';
import { hashOf, HashIndex, type IndexEntry } from '../src/db/hash-index.js';
import { Db } from '../src/db/open.js';
import { NOT_MODIFIED, PagesRepo, type PageRecord, type Provenance } from '../src/db/pages-repo.js';
import { RunsRepo } from '../src/db/runs-repo.js';
import { SitesRepo } from '../src/db/sites-repo.js';
import { LockedError } from '../src/db/lock.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
const who: Provenance = { cat: 'pizza-au', list: 'shops.au', run: 'r1', site: 'https://a.com/' };
const rec = (url: string, email: string, at = Date.now()): PageRecord => ({ url, emails: [{ email, name: null }], links: [], at });
const always = () => true;
const entry = (offset: number, at: number): IndexEntry => ({ offset, length: 10, at, gone: false });

// ---------------------------------------------------------------- hash index

test('hash index: set, get, newest wins, survives reopen', () => {
  const file = path.join(tmp(), 'x.idx');
  let ix = HashIndex.open(file);
  assert.ok(ix.fresh);
  const h = hashOf('http\0a.com/');
  assert.equal(ix.set(h, entry(0, 100), always), 'added');
  assert.equal(ix.set(h, entry(50, 200), always), 'updated');
  assert.equal(ix.set(h, entry(99, 150), always), 'kept', 'an older record never replaces a newer one');
  assert.deepEqual(ix.get(h, always), { offset: 50, length: 10, at: 200, gone: false });
  ix.flush(1234);
  ix.close();
  ix = HashIndex.open(file);
  assert.ok(!ix.fresh);
  assert.equal(ix.indexedBytes, 1234);
  assert.equal(ix.count, 1);
  assert.equal(ix.get(h, always)?.offset, 50);
  assert.equal(ix.get(hashOf('http\0b.com/'), always), undefined);
  ix.close();
});

test('hash index: grows past its first size and keeps every entry', () => {
  const ix = HashIndex.open(path.join(tmp(), 'x.idx'), 10);
  const n = 20_000; // far more than the 4096-slot start holds below the load limit
  for (let i = 0; i < n; i++) ix.set(hashOf(`k${i}`), entry(i * 7, i), always);
  assert.equal(ix.count, n);
  for (const i of [0, 1, 4095, 4096, 12_345, n - 1]) assert.equal(ix.get(hashOf(`k${i}`), always)?.offset, i * 7, `entry ${i}`);
  ix.close();
});

test('hash index: ids with the same hash are told apart by the caller', () => {
  const ix = HashIndex.open(path.join(tmp(), 'x.idx'));
  const h = hashOf('same');
  ix.set(h, entry(1, 1), (e) => e.offset === 1);
  ix.set(h, entry(2, 1), (e) => e.offset === 2); // `same` says the first is another id: a second slot
  assert.equal(ix.count, 2);
  assert.equal(ix.get(h, (e) => e.offset === 1)?.offset, 1);
  assert.equal(ix.get(h, (e) => e.offset === 2)?.offset, 2);
  ix.close();
});

test('hash index: a damaged file is replaced by an empty one', () => {
  const file = path.join(tmp(), 'x.idx');
  fs.writeFileSync(file, 'not an index');
  const ix = HashIndex.open(file);
  assert.ok(ix.fresh);
  ix.close();
});

// ---------------------------------------------------------------- pages

const pagesFiles = (dir: string) => ({ data: path.join(dir, 'pages.jsonl'), index: path.join(dir, 'pages.idx') });

test('pages: stored pages are found again after reopening, without rebuilding the index', async () => {
  const f = pagesFiles(tmp());
  let repo = new PagesRepo(f);
  const v = repo.view(who);
  const r = await v.load('http', 'a.com/x', 0, async () => rec('https://a.com/x', 'x@a.com'));
  assert.equal(r && r !== 'gone' && r.reused, false);
  repo.close();
  const idxBefore = fs.statSync(f.index).mtimeMs;
  repo = new PagesRepo(f);
  assert.equal(repo.pages, 1);
  assert.equal(repo.getRecord('http', 'a.com/x')?.emails[0].email, 'x@a.com');
  assert.equal(repo.getRecord('browser', 'a.com/x'), undefined, 'modes are separate');
  assert.equal(fs.statSync(f.index).mtimeMs, idxBefore, 'the index was reused, not rewritten');
  repo.close();
});

test('pages: a record carries its identifiers and who fetched it', async () => {
  const f = pagesFiles(tmp());
  const repo = new PagesRepo(f);
  repo.view(who).put('browser', 'a.com/c?x=1', rec('https://www.a.com/c?x=1', 'c@a.com', 5), Infinity);
  repo.view(who).markGone('http', 'a.com/missing', 6);
  repo.close();
  const lines = fs.readFileSync(f.data, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual({ ...lines[0], page: undefined }, { version: 2, pageKey: 'a.com/c?x=1', mode: 'browser', fetchedAt: 5, host: 'a.com', cat: 'pizza-au', list: 'shops.au', site: 'https://a.com/', run: 'r1', page: undefined });
  assert.equal(lines[0].page.url, 'https://www.a.com/c?x=1');
  assert.equal(lines[1].gone, 1);
  assert.equal(fs.statSync(f.data).mode & 0o777, 0o600);
});

test('pages: reopening indexes only what was written after the index (a crash before the last checkpoint)', () => {
  const f = pagesFiles(tmp());
  let repo = new PagesRepo(f);
  repo.view(who).put('http', 'a.com/1', rec('u', 'a@a.com', 1));
  repo.close();
  // a record the index never heard of, as left by a run that died before closing
  const extra = fs.readFileSync(f.data, 'utf8').split('\n')[0].replace('"pageKey":"a.com/1"', '"pageKey":"a.com/2"');
  fs.appendFileSync(f.data, extra + '\n');
  repo = new PagesRepo(f);
  assert.equal(repo.pages, 2);
  assert.ok(repo.getRecord('http', 'a.com/2'));
  repo.close();
});

test('pages: a missing or corrupt index is rebuilt from the data', () => {
  const f = pagesFiles(tmp());
  let repo = new PagesRepo(f);
  for (let i = 0; i < 50; i++) repo.view(who).put('http', `a.com/${i}`, rec('u', `e${i}@a.com`, i + 1));
  repo.close();
  fs.rmSync(f.index);
  repo = new PagesRepo(f);
  assert.equal(repo.pages, 50);
  assert.equal(repo.getRecord('http', 'a.com/49')?.emails[0].email, 'e49@a.com');
  repo.close();
  fs.writeFileSync(f.index, Buffer.alloc(100));
  repo = new PagesRepo(f);
  assert.equal(repo.pages, 50);
  repo.close();
});

test('pages: a record cut off by a crash is ignored and the next one starts on its own line', () => {
  const f = pagesFiles(tmp());
  const repo = new PagesRepo(f);
  repo.view(who).put('http', 'a.com/1', rec('u', 'a@a.com', 1));
  repo.close();
  fs.appendFileSync(f.data, '{"v":1,"k":"a.com/2","m":"http","a":2,"host":"a.com","cat":null,"list":null,"site":null,"run":"r","d":{"url":"u","emai');
  const again = new PagesRepo(f);
  assert.equal(again.getRecord('http', 'a.com/2'), undefined, 'the truncated record does not read back');
  again.view(who).put('http', 'a.com/3', rec('u', 'c@a.com', 3));
  again.close();
  const third = new PagesRepo(f);
  assert.ok(third.getRecord('http', 'a.com/3'));
  assert.ok(third.getRecord('http', 'a.com/1'));
  third.close();
});

test('pages: the newest copy wins, and a stale copy is handed to fetch for revalidation', async () => {
  const f = pagesFiles(tmp());
  const repo = new PagesRepo(f);
  const v = repo.view(who);
  v.put('http', 'a.com/p', { ...rec('u', 'old@a.com', 100), etag: 'E1' });
  let seen: PageRecord | undefined;
  const r = await v.load('http', 'a.com/p', 200, async (stale) => { seen = stale; return { ...stale!, at: 300 }; });
  assert.equal(seen?.etag, 'E1');
  assert.equal(r && r !== 'gone' && r.reused, false);
  assert.equal(repo.getRecord('http', 'a.com/p')?.at, 300);
  const reused = await v.load('http', 'a.com/p', 250, async () => { throw new Error('must not fetch'); });
  assert.ok(reused && reused !== 'gone' && reused.reused);
  repo.close();
});

test('pages: simultaneous loads of one page fetch it once; a 404 is remembered', async () => {
  const repo = new PagesRepo(pagesFiles(tmp()));
  const v = repo.view(who);
  let calls = 0;
  const fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return rec('u', 'x@a.com'); };
  const [a, b] = await Promise.all([v.load('http', 'a.com/s', 0, fetch), v.load('http', 'a.com/s', 0, fetch)]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b].map((x) => x !== 'gone' && x?.reused).sort(), [false, true]);
  v.markGone('http', 'a.com/404');
  assert.equal(await v.load('http', 'a.com/404', 0, async () => { throw new Error('no'); }), 'gone');
  repo.close();
});

test('pages: lookups stay fast with many pages (and the index finds each one)', () => {
  const f = pagesFiles(tmp());
  const repo = new PagesRepo(f);
  const n = 30_000;
  for (let i = 0; i < n; i++) repo.view(who).put('http', `h${i % 500}.com/page/${i}`, rec('u', `e${i}@x.com`, i + 1));
  repo.close();
  const t0 = Date.now();
  const again = new PagesRepo(f);
  assert.equal(again.pages, n);
  for (let i = 0; i < 1000; i++) {
    const k = (i * 29) % n;
    assert.equal(again.getRecord('http', `h${k % 500}.com/page/${k}`)?.emails[0].email, `e${k}@x.com`);
  }
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  again.close();
});

test('pages: importing skips a page the store already has a copy of at least as new', () => {
  const repo = new PagesRepo(pagesFiles(tmp()));
  assert.equal(repo.importLine('http', 'a.com/i', 10, '{"v":1,"k":"a.com/i","m":"http","a":10,"host":"a.com","cat":"c","list":null,"site":null,"run":"legacy","d":{"url":"u","emails":[],"links":[],"at":10}}', false), true);
  assert.equal(repo.importLine('http', 'a.com/i', 10, 'x', false), false, 'same age: skipped');
  assert.equal(repo.importLine('http', 'a.com/i', 5, 'x', false), false, 'older: skipped');
  assert.equal(repo.pages, 1);
  repo.close();
});

// ---------------------------------------------------------------- sites

const site = (url: string, emails = 0, extra: Partial<SiteResult> = {}): SiteResult => ({
  v: 3, site: url, finalUrl: url, business: 'b', pages: 1, usedBrowser: false,
  emails: Array.from({ length: emails }, (_, i) => ({ email: `e${i}@x.com`, name: null, link: url })), ...extra,
});
const sitesFiles = (dir: string) => ({ data: path.join(dir, 'sites.jsonl'), index: path.join(dir, 'sites.idx') });
const ref = (g = 1, list = 'l') => ({ cat: 'c', list, generation: g, run: 'r' });

test('sites: the last row of a site wins and rows are found after reopening', () => {
  const f = sitesFiles(tmp());
  let repo = new SitesRepo(f);
  repo.append(ref(), site('https://a.com/', 0, { error: 'unreachable' }));
  repo.append(ref(), site('https://b.com/', 2));
  repo.append(ref(), site('https://a.com/', 1)); // a retry's newer row
  repo.append(ref(1, 'other'), site('https://z.com/'));
  const loaded = repo.loadList('c', 'l');
  assert.deepEqual([...loaded.keys()].sort(), ['https://a.com/', 'https://b.com/']);
  assert.equal(loaded.get('https://a.com/')!.emails.length, 1);
  repo.close();
  repo = new SitesRepo(f);
  assert.equal(repo.loadList('c', 'l').get('https://b.com/')!.emails.length, 2);
  assert.equal(repo.loadList('c', 'other').size, 1);
  repo.close();
});

test('sites: a drop removes a site until it is scraped again', () => {
  const repo = new SitesRepo(sitesFiles(tmp()));
  repo.append(ref(), site('https://a.com/', 0, { error: 'unreachable' }));
  repo.append(ref(), site('https://b.com/', 1));
  repo.drop(ref(), 'https://a.com/');
  assert.deepEqual([...repo.loadList('c', 'l').keys()], ['https://b.com/']);
  repo.append(ref(), site('https://a.com/', 3));
  assert.equal(repo.loadList('c', 'l').get('https://a.com/')!.emails.length, 3);
  repo.close();
});

test('sites: a newer generation starts empty and the older one stays on disk', () => {
  const f = sitesFiles(tmp());
  const repo = new SitesRepo(f);
  repo.append(ref(1), site('https://a.com/', 1));
  assert.equal(repo.generation('c', 'l'), 1);
  assert.equal(repo.loadList('c', 'l', 2).size, 0, 'generation 2 has no rows yet');
  repo.append(ref(2), site('https://b.com/', 1));
  assert.deepEqual([...repo.loadList('c', 'l').keys()], ['https://b.com/']);
  assert.deepEqual([...repo.loadList('c', 'l', 1).keys()], ['https://a.com/'], 'the earlier generation can still be read');
  assert.equal(fs.readFileSync(f.data, 'utf8').trim().split('\n').length, 2);
  repo.close();
});

test('sites: a snapshot of the index speeds reopening, and rows written after it are still found', () => {
  const f = sitesFiles(tmp());
  let repo = new SitesRepo(f);
  repo.append(ref(), site('https://a.com/', 1, { business: 'x'.repeat(5 << 20) })); // big enough to be worth a snapshot
  repo.close();
  assert.ok(fs.existsSync(f.index));
  repo = new SitesRepo(f);
  repo.append(ref(), site('https://b.com/', 1));
  repo.close();
  repo = new SitesRepo(f);
  assert.deepEqual([...repo.loadList('c', 'l').keys()].sort(), ['https://a.com/', 'https://b.com/']);
  repo.close();
});

test('sites: a record cut off by a crash is skipped and later rows still read', () => {
  const f = sitesFiles(tmp());
  let repo = new SitesRepo(f);
  repo.append(ref(), site('https://a.com/', 1));
  repo.close();
  fs.appendFileSync(f.data, '{"v":1,"t":"site","cat":"c","list":"l","g":1,"run":"r","a":1,"site":"https://cut.com/","r":{"v":3,"si');
  repo = new SitesRepo(f);
  repo.append(ref(), site('https://b.com/', 1));
  const loaded = repo.loadList('c', 'l');
  assert.deepEqual([...loaded.keys()].sort(), ['https://a.com/', 'https://b.com/'], 'the cut-off record is not indexed');
  repo.close();
});

// ---------------------------------------------------------------- run history

test('runs: a list is interrupted until its latest start has an end', () => {
  const file = path.join(tmp(), 'run-history.jsonl');
  let runs = new RunsRepo(file);
  assert.equal(runs.interrupted('c', 'l'), undefined);
  runs.append({ type: 'list.start', run: 'r1', cat: 'c', list: 'l', generation: 1 });
  assert.equal(runs.interrupted('c', 'l')?.generation, 1);
  runs.close();
  runs = new RunsRepo(file); // a later process sees it too
  assert.equal(runs.interrupted('c', 'l')?.run, 'r1');
  assert.deepEqual(runs.interruptedLists().map((x) => `${x.cat}/${x.list}`), ['c/l']);
  runs.append({ type: 'list.end', run: 'r2', cat: 'c', list: 'l', generation: 1, status: 'finished' });
  assert.equal(runs.interrupted('c', 'l'), undefined);
  runs.append({ type: 'list.start', run: 'r3', cat: 'c', list: 'l', generation: 2 });
  assert.equal(runs.interrupted('c', 'l')?.generation, 2);
  assert.equal(runs.startedGeneration('c', 'l'), 2);
  const seen: string[] = [];
  runs.scan((e) => seen.push(e.type));
  assert.deepEqual(seen, ['list.start', 'list.end', 'list.start']);
  runs.close();
});

// ---------------------------------------------------------------- the whole database

test('db: beginList resumes an interrupted list and opens a new generation for a re-scrape', () => {
  const out = tmp();
  const db = new Db(out);
  const first = db.beginList({ cat: 'c', list: 'l', run: 'r1', mode: 'scrape', sites: 2, outputExists: false, keep: false });
  assert.deepEqual([first.generation, first.resumed, first.fresh], [1, false, false]);
  db.sites.append(first, site('https://a.com/', 1));
  db.close();

  const db2 = new Db(out); // the run died before list.end: the next one resumes
  const second = db2.beginList({ cat: 'c', list: 'l', run: 'r2', mode: 'scrape', sites: 2, outputExists: false, keep: false });
  assert.deepEqual([second.generation, second.resumed], [1, true]);
  assert.equal(db2.sites.loadList('c', 'l', second.generation).size, 1);
  db2.runs.append({ type: 'list.end', run: 'r2', cat: 'c', list: 'l', generation: 1, status: 'finished' });

  const retry = db2.beginList({ cat: 'c', list: 'l', run: 'r3', mode: 'retry', sites: 2, outputExists: true, keep: true });
  assert.deepEqual([retry.generation, retry.fresh], [1, false], 'a retry builds on the current results');
  db2.runs.append({ type: 'list.end', run: 'r3', cat: 'c', list: 'l', generation: 1, status: 'finished' });

  const again = db2.beginList({ cat: 'c', list: 'l', run: 'r4', mode: 'scrape', sites: 2, outputExists: true, keep: false });
  assert.deepEqual([again.generation, again.fresh], [2, true], 'a finished list scraped again starts a new generation');
  assert.equal(db2.sites.loadList('c', 'l', again.generation).size, 0);
  db2.close();
});

test('db: one run at a time holds the page store', () => {
  const out = tmp();
  const a = new Db(out);
  void a.pages;
  fs.writeFileSync(path.join(a.files.locksDir, 'pages.lock'), String(process.ppid)); // pretend another live process owns it
  const b = new Db(out);
  assert.throws(() => b.pages, LockedError);
  b.close();
  a.close();
});

// ------------------------------------------------ revalidation, and the version 1 names

const V1_LINE = (key: string, at: number, email: string) =>
  `{"v":1,"k":"${key}","m":"http","a":${at},"host":"a.com","cat":"c","list":null,"site":null,"run":"legacy","d":{"url":"https://a.com/","emails":[{"email":"${email}","name":null}],"links":[],"at":${at}}}\n`;
const linesOf = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('pages: records written with the version 1 names (v,k,m,a,d) are found, indexed and read', () => {
  const f = pagesFiles(tmp());
  fs.writeFileSync(f.data, V1_LINE('a.com/old', 1_700_000_000_000, 'old@a.com'));
  const repo = new PagesRepo(f); // builds the index over the old line
  assert.equal(repo.has('http', 'a.com/old'), 1_700_000_000_000);
  assert.equal(repo.getRecord('http', 'a.com/old')?.emails[0].email, 'old@a.com');
  repo.view(who).put('http', 'a.com/new', rec('u', 'new@a.com', 1_700_000_000_005));
  repo.close();
  const lines = linesOf(f.data);
  assert.match(lines[0], /^\{"v":1,"k":/);
  assert.match(lines[1], /^\{"version":2,"pageKey":"a\.com\/new","mode":"http","fetchedAt":1700000000005,/);
  const again = new PagesRepo(f); // reopened: both versions in one file are found
  assert.equal(again.getRecord('http', 'a.com/old')?.emails[0].email, 'old@a.com');
  assert.equal(again.getRecord('http', 'a.com/new')?.emails[0].email, 'new@a.com');
  again.close();
});

for (const [name, first] of [['version 1', V1_LINE('a.com/p', 1_700_000_000_000, 'p@a.com')], ['version 2', null]] as const) {
  test(`pages: a 304 renews the time of the stored record in place (${name} line), copying nothing`, async () => {
    const f = pagesFiles(tmp());
    if (first) fs.writeFileSync(f.data, first);
    let repo = new PagesRepo(f);
    if (!first) repo.view(who).put('http', 'a.com/p', rec('u', 'p@a.com', 1_700_000_000_000));
    const before = fs.readFileSync(f.data, 'utf8');
    const t0 = Date.now();
    const r = await repo.view(who).load('http', 'a.com/p', t0 + 1000, async () => NOT_MODIFIED);
    assert.ok(r && r !== 'gone' && !r.reused);
    assert.equal(r.rec.emails[0].email, 'p@a.com');
    assert.ok(r.rec.at >= t0, 'the page now says it was checked today');
    const after = fs.readFileSync(f.data, 'utf8');
    assert.equal(after.length, before.length, 'no record was appended and the line kept its length');
    assert.equal(after.split('\n').filter(Boolean).length, 1);
    assert.equal(after.replace(/\d{13}/g, 'T'), before.replace(/\d{13}/g, 'T'), 'only the time digits changed');
    assert.equal(repo.has('http', 'a.com/p'), r.rec.at);
    repo.close();
    repo = new PagesRepo(f); // the new time is what the file says, so a rebuilt index agrees
    assert.equal(repo.getRecord('http', 'a.com/p')?.at, r.rec.at);
    repo.close();
    fs.rmSync(f.index);
    repo = new PagesRepo(f);
    assert.equal(repo.has('http', 'a.com/p'), r.rec.at);
    repo.close();
  });
}

test('pages: a 200 replaces the old record with the new content', async () => {
  const f = pagesFiles(tmp());
  fs.writeFileSync(f.data, V1_LINE('a.com/p', 1_700_000_000_000, 'old@a.com'));
  const repo = new PagesRepo(f);
  const r = await repo.view(who).load('http', 'a.com/p', Date.now() + 1000, async () => rec('u', 'new@a.com', Date.now()));
  assert.ok(r && r !== 'gone' && !r.reused);
  assert.equal(repo.getRecord('http', 'a.com/p')?.emails[0].email, 'new@a.com');
  assert.equal(linesOf(f.data).length, 2, 'the new version is appended; db:upgrade drops the old line');
  repo.close();
});
