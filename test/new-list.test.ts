import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildList, currentListName, isBlocked, nextListName } from '../scripts/new-list.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-newlist-'));

test('nextListName: base first, then -2, -3 without touching existing files', () => {
  const dir = tmp();
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\n');
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops-2.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops-2.au.csv'), 'name,website\n');
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops-3.au.csv');
  assert.equal(nextListName(dir, 'pizza-chains', 'au'), 'pizza-chains.au.csv');
  assert.equal(nextListName(dir, 'pizza-shops', 'nz'), 'pizza-shops.nz.csv');
});

test('buildList: drops known sites, platforms, invalid and repeated candidates', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\nOld,https://www.oldpizza.com.au\n');
  const cand = path.join(tmp(), 'c.csv');
  fs.writeFileSync(cand, [
    'name,website',
    'Old again,http://oldpizza.com.au/',
    'New,https://newpizza.com.au/#top',
    'New twice,https://www.newpizza.com.au',
    'Insta,https://instagram.com/somepizza',
    'Uber,https://www.ubereats.com/store/x',
    'Bad,not a url',
    'Other,https://luigis.co.nz/menu',
  ].join('\n'));
  const r = buildList(dir, 'pizza-shops', 'au', cand);
  assert.equal(path.basename(r.file), 'pizza-shops-2.au.csv');
  assert.deepEqual(r.rows, [{ name: 'New', website: 'https://newpizza.com.au' }, { name: 'Other', website: 'https://luigis.co.nz/menu' }]);
  assert.deepEqual([r.known, r.blocked, r.invalid, r.repeated], [1, 2, 1, 1]);
  assert.equal(fs.readdirSync(dir).length, 1); // buildList writes nothing
});

test('isBlocked: matches the registrable domain, not lookalikes', () => {
  assert.equal(isBlocked('https://m.facebook.com/x'), true);
  assert.equal(isBlocked('https://www.menulog.com.au/'), true);
  assert.equal(isBlocked('https://facebookpizza.com.au/'), false);
  assert.equal(isBlocked('https://venues.posbosshq.com/NZ/my-store-4867'), true);
  assert.equal(isBlocked('https://pizzabros.co.nz/'), false);
  assert.equal(isBlocked('http://clunesps.vic.edu.au'), true);
  assert.equal(isBlocked('https://www.ozfoodhunter.com.au/euro-pizza'), true);
  assert.equal(isBlocked('https://forestopizza.square.site'), false);
});

test('currentListName / append: later batches target the numbered file, never the base list', () => {
  const dir = tmp();
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), null);
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\nA,https://a.com.au\n');
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), null);
  const cand = path.join(tmp(), 'cand.csv');
  fs.writeFileSync(cand, 'name,website\nB,https://b.com.au\n');
  assert.equal(path.basename(buildList(dir, 'pizza-shops', 'au', cand, true).file), 'pizza-shops-2.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops-2.au.csv'), 'name,website\nB,https://b.com.au\n');
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), 'pizza-shops-2.au.csv');
  fs.writeFileSync(cand, 'name,website\nB,https://b.com.au\nC,https://c.com.au\n');
  const r = buildList(dir, 'pizza-shops', 'au', cand, true);
  assert.equal(path.basename(r.file), 'pizza-shops-2.au.csv');
  assert.deepEqual(r.rows.map((x) => x.website), ['https://c.com.au']);
  assert.equal(path.basename(buildList(dir, 'pizza-shops', 'au', cand).file), 'pizza-shops-3.au.csv');
});

test('validateFiles: drops duplicates across files (earlier file wins), platforms and invalid rows', async () => {
  const { validateFiles } = await import('../scripts/validate-lists.js');
  const dir = tmp();
  const a = path.join(dir, 'a.au.csv');
  const b = path.join(dir, 'b.au.csv');
  fs.writeFileSync(a, 'name,website\nOne,https://www.one.com.au\nOne again,https://one.com.au/\nFb,https://facebook.com/x\n');
  fs.writeFileSync(b, 'name,website\nOne,https://one.com.au\nTwo,https://two.com.au\nBad,not a url\n');
  const [ra, rb] = validateFiles([a, b]);
  assert.deepEqual(ra.rows.map((r) => r.website), ['https://www.one.com.au']);
  assert.equal(ra.repeated, 1);
  assert.equal(ra.blocked, 1);
  assert.deepEqual(rb.rows.map((r) => r.website), ['https://two.com.au']);
  assert.equal(rb.known, 1);
  assert.equal(rb.invalid, 1);
});

test('foreignTld: keeps generic and own-country domains, drops other countries', async () => {
  const { foreignTld } = await import('../scripts/new-list.js');
  for (const u of ['https://a.com.au', 'https://a.net.au', 'https://a.com', 'https://a.kiwi', 'https://a.melbourne', 'https://a.co', 'https://a.io', 'https://a.gd', 'https://x.square.site']) assert.equal(foreignTld(u, 'au'), false, u);
  for (const u of ['https://a.co.uk', 'https://a.co.nz', 'https://a.jp', 'https://a.de', 'https://a.co.za']) assert.equal(foreignTld(u, 'au'), true, u);
  assert.equal(foreignTld('https://a.com.au', 'nz'), true);
  assert.equal(foreignTld('https://a.co.nz', 'nz'), false);
});

test('validateFiles / buildList with the country option drop other-country domains', async () => {
  const { validateFiles } = await import('../scripts/validate-lists.js');
  const dir = tmp();
  const f = path.join(dir, 'x.nz.csv');
  fs.writeFileSync(f, 'name,website\nA,https://a.co.nz\nB,https://b.com.au\nC,https://c.com\n');
  const [r] = validateFiles([f], true);
  assert.deepEqual(r.rows.map((x) => x.website), ['https://a.co.nz', 'https://c.com']);
  assert.equal(r.foreign, 1);
  assert.equal(validateFiles([f])[0].foreign, 0);
  const cand = path.join(tmp(), 'c.csv');
  fs.writeFileSync(cand, 'name,website\nD,https://d.co.nz\nB,https://b.com.au\n');
  const b = buildList(dir, 'y', 'nz', cand, false, true);
  assert.equal(b.foreign, 1);
  assert.equal(b.rows.length, 1);
});
