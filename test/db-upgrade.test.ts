import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db/open.js';
import { upgradeDb } from '../src/db/upgrade.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'db-upgrade-'));
const page = (key: string, at: number, email: string, extra = '') =>
  `{"v":1,"k":"${key}","m":"http","a":${at},"host":"a.com","cat":"c","list":"l","site":"https://a.com/","run":"r0","d":{"url":"https://a.com/","emails":[{"email":"${email}","name":null}],"links":[],"at":${at}}}\n${extra}`;
const siteRow = (t: string, g: number, site: string, r = `,"r":{"site":"${site}","emails":[],"pages":1}`) =>
  `{"v":1,"t":"${t}","cat":"c","list":"l","g":${g},"run":"r0","a":1700000000000,"site":"${site}"${r}}\n`;
const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

/** A results/ folder whose db/ holds files written by the version 1 code. */
function legacyDb() {
  const out = tmp();
  const dir = path.join(out, 'db');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'pages.jsonl'),
    page('a.com/1', 1_700_000_000_001, 'old@a.com') // replaced below by a newer copy of the same page
    + page('a.com/2', 1_700_000_000_002, 'two@a.com')
    + page('a.com/1', 1_700_000_000_003, 'new@a.com')
    + '{"v":1,"k":"a.com/gone","m":"http","a":1700000000004,"host":"a.com","cat":null,"list":null,"site":null,"run":"r0","gone":1}\n'
    + '{"v":1,"k":"a.com/cut","m":"http","a":1700000000005,"host":"a.com","cat":null,"d":{"url":"u","emai\n');
  fs.writeFileSync(path.join(dir, 'sites.jsonl'),
    siteRow('site', 1, 'https://a.com/') + siteRow('site', 2, 'https://a.com/') + siteRow('drop', 2, 'https://a.com/', '') + siteRow('site', 2, 'https://b.com/'));
  fs.writeFileSync(path.join(dir, 'run-history.jsonl'),
    '{"v":1,"t":"list.start","run":"r0","cat":"c","list":"l","g":2,"a":1700000000000,"ts":"2023-11-14T22:13:20.000Z"}\n');
  return { out, dir };
}

test('db:upgrade: dry run changes nothing', () => {
  const { out, dir } = legacyDb();
  const before = ['pages.jsonl', 'sites.jsonl', 'run-history.jsonl'].map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
  const r = upgradeDb({ outDir: out, dryRun: true });
  assert.deepEqual(r.map((x) => [x.converted, x.dropped, x.upgraded]), [[3, 2, false], [4, 0, false], [1, 0, false]]);
  assert.deepEqual(['pages.jsonl', 'sites.jsonl', 'run-history.jsonl'].map((n) => fs.readFileSync(path.join(dir, n), 'utf8')), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['locks', 'pages.idx', 'pages.jsonl', 'run-history.jsonl', 'sites.jsonl']);
});

test('db:upgrade: renames the fields, drops replaced and cut-off records, and the database works on the result', () => {
  const { out, dir } = legacyDb();
  const [pages, sites, runs] = upgradeDb({ outDir: out });
  assert.deepEqual([pages.upgraded, sites.upgraded, runs.upgraded], [true, true, true]);

  const p = lines(path.join(dir, 'pages.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual(p.map((x) => x.pageKey).sort(), ['a.com/1', 'a.com/2', 'a.com/gone'], 'one record per page; the replaced copy and the cut-off line are gone');
  assert.ok(p.every((x) => x.version === 2 && x.v === undefined && x.k === undefined && x.d === undefined));
  const one = p.find((x) => x.pageKey === 'a.com/1');
  assert.deepEqual([one.mode, one.fetchedAt, one.cat, one.list, one.site, one.run, one.page.emails[0].email], ['http', 1_700_000_000_003, 'c', 'l', 'https://a.com/', 'r0', 'new@a.com']);
  assert.equal(p.find((x) => x.pageKey === 'a.com/gone').gone, 1);

  const s = lines(path.join(dir, 'sites.jsonl')).map((l) => JSON.parse(l));
  assert.equal(s.length, 4, 'every site row stays, older generations included');
  assert.ok(s.every((x) => x.version === 2 && x.t === undefined && x.g === undefined && (x.type === 'drop' || x.result.site)));
  assert.deepEqual(s.map((x) => [x.type, x.generation]), [['site', 1], ['site', 2], ['drop', 2], ['site', 2]]);

  const r = lines(path.join(dir, 'run-history.jsonl')).map((l) => JSON.parse(l));
  assert.deepEqual([r[0].version, r[0].type, r[0].generation, r[0].at], [2, 'list.start', 2, 1_700_000_000_000]);

  assert.ok(!fs.existsSync(path.join(dir, 'pages.idx')) && !fs.existsSync(path.join(dir, 'pages.jsonl.upgrade')), 'the old index is gone and no temporary file is left');

  const db = new Db(out); // opens and indexes the new files
  try {
    assert.equal(db.pages.getRecord('http', 'a.com/1')?.emails[0].email, 'new@a.com');
    assert.equal(db.pages.has('http', 'a.com/gone'), 1_700_000_000_004);
    assert.deepEqual([...db.sites.loadList('c', 'l').keys()], ['https://b.com/'], 'generation 2: a.com was dropped');
    assert.deepEqual([...db.sites.loadList('c', 'l', 1).keys()], ['https://a.com/']);
    assert.deepEqual(db.runs.interrupted('c', 'l') && [db.runs.interrupted('c', 'l')!.generation, db.runs.interrupted('c', 'l')!.at], [2, 1_700_000_000_000]);
  } finally {
    db.close();
  }
});

test('db:upgrade: a database that is already current is left alone', () => {
  const { out, dir } = legacyDb();
  upgradeDb({ outDir: out });
  const db = new Db(out);
  db.pages.getRecord('http', 'a.com/1'); // forces the index to be built again
  db.close();
  const before = fs.readFileSync(path.join(dir, 'pages.jsonl'));
  const again = upgradeDb({ outDir: out });
  assert.deepEqual(again.map((x) => [x.converted, x.dropped, x.upgraded]), [[0, 0, false], [0, 0, false], [0, 0, false]]);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'pages.jsonl')), before);

  assert.ok(!fs.existsSync(path.join(dir, 'locks', 'pages.lock')), 'the pages lock is released when it is done');
});
