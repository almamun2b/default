import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/open.js';
import type { SiteResult } from '../src/crawler.js';
import { assignRows, loadDomainBusiness } from '../src/output.js';

const site = (s: string, extra: Partial<SiteResult> = {}): SiteResult => ({ site: s, finalUrl: s, business: 'Biz', emails: [], pages: 1, usedBrowser: false, ...extra });
const e = (email: string, link: string, extra: Record<string, unknown> = {}) => ({ email, name: null, link, ...extra });
const names = (sites: string[], done: Map<string, SiteResult>, input?: Map<string, string>) => assignRows(sites, done, input).rows.map((r) => [r[1], r[0]]);

test('names: own domain gets the business, a branch mailbox "Business - Local", a person their name; never blank', () => {
  const s = 'https://electrical.obrien.com.au/';
  const done = new Map([[s, site(s, { business: "O'Brien Electrical", emails: [
    e('info@obrien.com.au', s), e('geebung@electrical.obrien.com.au', s), e('keith@obrien.com.au', s), e('paul.wu@obrien.com.au', s),
    e('customer.relations@obrien.com.au', s), e('0zbi@obrien.com.au', s),
  ] })]]);
  assert.deepEqual(names([s], done), [
    ['info@obrien.com.au', "O'Brien Electrical"],
    ['geebung@electrical.obrien.com.au', "O'Brien Electrical - Geebung"],
    ['keith@obrien.com.au', 'Keith'],
    ['paul.wu@obrien.com.au', 'Paul Wu'],
    ['customer.relations@obrien.com.au', "O'Brien Electrical - Customer Relations"],
    ['0zbi@obrien.com.au', "O'Brien Electrical"],
  ]);
});

test("names: another company's email is named by the list site that owns the domain, else by its own domain", () => {
  const dealer = 'https://kellysuzuki.com.au/', group = 'https://ktmg.com.au/';
  const done = new Map([
    [dealer, site(dealer, { business: 'Kelly Suzuki', emails: [e('fleet@ktmg.com.au', dealer), e('sales@vendor.com', dealer), e('anna@vendor.com', dealer)] })],
    [group, site(group, { business: 'Kelly Trotter Motor Group', emails: [] })],
  ]);
  assert.deepEqual(names([dealer, group], done), [
    ['fleet@ktmg.com.au', 'Kelly Trotter Motor Group - Fleet'],
    ['sales@vendor.com', 'Vendor - Sales'],
    ['anna@vendor.com', 'Anna'],
  ]);
});

test('names: a landing page on an unrelated domain does not give that domain\'s emails the input name', () => {
  const s = 'http://www.bestbitepizza.com.au/';
  const landing = 'https://www.change.org/';
  const done = new Map([[s, site(s, { finalUrl: landing, business: 'Change.org', emails: [
    e('copyright@change.org', `${landing}policies/terms-of-service`), e('info@change.org', landing), e('david.zaslav@wbd.com', `${landing}p/x`), e('hello@bestbitepizza.com.au', s),
  ] })]]);
  const out = assignRows([s], done, new Map([[s, 'Best Bite Pizza']]));
  assert.deepEqual(out.rows.map((r) => [r[1], r[0]]), [
    ['copyright@change.org', 'Change - Copyright'],
    ['info@change.org', 'Change'],
    ['david.zaslav@wbd.com', 'David Zaslav'],
    ['hello@bestbitepizza.com.au', 'Best Bite Pizza'],
  ]);
  assert.deepEqual(out.redirects, ['bestbitepizza.com.au → change.org']);
});

test('names: a related redirect (bare to www, .com to .co.nz) is still the same business', () => {
  const s = 'https://acme.com/';
  const done = new Map([[s, site(s, { finalUrl: 'https://www.acme.co.nz/', business: 'Acme', emails: [e('info@acme.co.nz', 'https://www.acme.co.nz/')] })]]);
  assert.deepEqual(names([s], done), [['info@acme.co.nz', 'Acme']]);
  assert.deepEqual(assignRows([s], done).redirects, []);
});

test('names: free-mail is the business on its contact pages or when there are few, else its own local part or domain', () => {
  const s = 'https://gourmetbasket.com.au/';
  const reviews = `${s}shop/hamper/reviews`;
  const done = new Map([[s, site(s, { business: 'Gourmet Basket', emails: [
    e('gourmetbasket1@gmail.com', `${s}contact`), e('debcopeland88@gmail.com', reviews), e('jonmegcoc@hotmail.com', reviews), e('rachop@optusnet.com.au', reviews), e('279942079@qq.com', reviews),
  ] })]]);
  assert.deepEqual(names([s], done), [
    ['gourmetbasket1@gmail.com', 'Gourmet Basket'],
    ['debcopeland88@gmail.com', 'Deb Copeland'],
    ['jonmegcoc@hotmail.com', 'Jonmegcoc'],
    ['rachop@optusnet.com.au', 'Rachop'],
    ['279942079@qq.com', 'qq.com'],
  ]);
});

test('names: outside the section an input was given for, the whole domain is named, never by the section\'s name', () => {
  const s = 'https://ucsa.org.nz/food/otto/';
  const done = new Map([[s, site(s, { business: 'UCSA', emails: [
    e('hello@ucsa.org.nz', s, { pageTitle: undefined }), e('president@ucsa.org.nz', 'https://ucsa.org.nz/aboutus/importantdocuments/'), e('info@ucsa.org.nz', 'https://ucsa.org.nz/contactus/'),
  ] })]]);
  assert.deepEqual(names([s], done, new Map([[s, 'Otto']])), [['hello@ucsa.org.nz', 'Otto'], ['president@ucsa.org.nz', 'Ucsa - President'], ['info@ucsa.org.nz', 'Ucsa']]);
});

test('names: a section sub-page title names a role mailbox, unless the page lists many emails', () => {
  const s = 'https://hospital.example.nz/';
  const landing = 'https://board.health.nz/hospitals/central';
  const page = `${landing}/cardiology`;
  const many = `${landing}/staff`;
  const done = new Map([[s, site(s, { finalUrl: landing, business: 'Central Hospital', emails: [
    e('info@board.health.nz', page, { pageTitle: 'Cardiology' }),
    ...['admin', 'office', 'reception', 'info'].map((x) => e(`${x}@board.health.nz`, many, { pageTitle: 'Staff directory' })),
  ] })]]);
  const rows = names([s], done);
  assert.equal(rows[0][1], 'Cardiology');
  assert.ok(rows.slice(1).every(([, n]) => n === 'Central Hospital'), JSON.stringify(rows));
});

test('names: a role mailbox keeps its role, a bare one does not, and a domain is words rather than a raw domain', () => {
  const s = 'https://example-club.com.au/';
  const done = new Map([[s, site(s, { business: 'Example Club', emails: [
    e('marketing@anytimefitness.in', s), e('info@smashtennis.co.nz', s), e('otorohangass@clmnz.co.nz', s), e('customerservice@anytimefitness.in', s), e('admin@kryalcastle.com.au', s),
  ] })]]);
  assert.deepEqual(names([s], done), [
    ['marketing@anytimefitness.in', 'Anytime Fitness - Marketing'],
    ['info@smashtennis.co.nz', 'Smash Tennis'],
    ['otorohangass@clmnz.co.nz', 'CLMNZ - Otorohangass'],
    ['customerservice@anytimefitness.in', 'Anytime Fitness - Customer Service'],
    ['admin@kryalcastle.com.au', 'Kryalcastle'],
  ]);
});

test('names: a sister domain with the same name is the site\'s own', () => {
  const s = 'https://www.smashtennis.nz/';
  const done = new Map([[s, site(s, { business: 'Smash Tennis NZ', emails: [e('info@smashtennis.co.nz', s), e('info@smashtennis.nz', s)] })]]);
  assert.deepEqual(names([s], done, new Map([[s, 'Smash Tennis']])), [['info@smashtennis.co.nz', 'Smash Tennis'], ['info@smashtennis.nz', 'Smash Tennis']]);
});

test('names: another company\'s domain takes the business name stored for it by any list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-names-'));
  const db = new Db(dir);
  db.sites.append({ cat: 'other', list: 'x', generation: 1, run: 't' }, site('https://www.clmnz.co.nz/', { business: 'Community Leisure Management' }));
  loadDomainBusiness(db, true);
  db.close();
  const s = 'https://venue.example.nz/';
  const done = new Map([[s, site(s, { business: 'Venue', emails: [e('otorohangass@clmnz.co.nz', s), e('info@clmnz.co.nz', s)] })]]);
  assert.deepEqual(names([s], done), [['otorohangass@clmnz.co.nz', 'Community Leisure Management - Otorohangass'], ['info@clmnz.co.nz', 'Community Leisure Management']]);
  loadDomainBusiness(new Db(fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-names-'))), true); // leave no names behind for other tests
});

test('names: a business name read from a section page is not the name of the whole domain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-names-'));
  const db = new Db(dir);
  db.sites.append({ cat: 'other', list: 'x', generation: 1, run: 't' }, site('https://www.mp.example/', { finalUrl: 'https://www.act.gov.au/ministers/mark-parton', business: 'Mark Parton MLA' }));
  loadDomainBusiness(db, true);
  db.close();
  const s = 'https://venue.example.nz/';
  const done = new Map([[s, site(s, { business: 'Venue', emails: [e('gentleman@act.gov.au', s)] })]]);
  assert.deepEqual(names([s], done), [['gentleman@act.gov.au', 'ACT - Gentleman']]);
  loadDomainBusiness(new Db(fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-names-'))), true);
});

test('names: a domain under an invented suffix keeps its own label', () => {
  const s = 'https://netballmanurewa.org.nz/';
  const done = new Map([[s, site(s, { business: 'Netball Manurewa', emails: [e('office@netballmanurewa.or.nz', s)] })]]);
  assert.deepEqual(names([s], done), [['office@netballmanurewa.or.nz', 'Netball Manurewa']]);
});

test('names: inputs deep in one domain (one page per MP) do not name the whole domain, and a short registrable label is kept', () => {
  const a = 'https://www.aph.gov.au/Senators/jane-roe', b = 'https://www.aph.gov.au/Senators/sam-poe';
  const done = new Map([
    [a, site(a, { business: 'Jane Roe - Parliament profile', emails: [e('senator.bell@aph.gov.au', a), e('info@info.aa.co.nz', a)] })],
    [b, site(b, { business: 'Sam Poe - Parliament profile', emails: [] })],
  ]);
  const rows = names([a, b], done, new Map([[a, 'Jane Roe (Senator)'], [b, 'Sam Poe (Senator)']]));
  assert.ok(rows.every(([, n]) => !/Roe|Poe/.test(n) || /^Jane Roe/.test(n)), JSON.stringify(rows));
  assert.equal(rows.find(([m]) => m === 'info@info.aa.co.nz')![1], 'AA');
});

test('names: on a host shared by many list sites, another site\'s person page does not name an email', () => {
  const pages = ['jane-roe', 'sam-poe', 'tim-moe'].map((p) => `https://www.aph.gov.au/Senators/${p}`);
  const done = new Map(pages.map((s) => [s, site(s, { business: 'Parliament profile', emails: s.endsWith('jane-roe') ? [e('senator.bell@aph.gov.au', s), e('jane.roe.sen@aph.gov.au', s)] : [] })]));
  const rows = names(pages, done, new Map(pages.map((s, i) => [s, ['Jane Roe (Senator)', 'Sam Poe (Senator)', 'Tim Moe (Senator)'][i]])));
  assert.deepEqual(rows, [['senator.bell@aph.gov.au', 'Aph - Senator Bell'], ['jane.roe.sen@aph.gov.au', 'Jane Roe Sen']]);
});
