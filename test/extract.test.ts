import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessName, cleanEmail, demoteRolePrefixes, demoteSharedPageNames, extractFromHtml, findEmails, localName, nameFromLocal, personName, recheckRow, tidyBusinessName, type Found } from '../src/extract.js';

const byEmail = (html: string) => Object.fromEntries(extractFromHtml(html).map((f) => [f.email, f.name]));

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

// ---------- baseline behaviour ----------

test('mailto with a person name as link text', () => {
  assert.deepEqual(byEmail('<a href="mailto:jane@x.co.nz">Dr Jane Smith</a>'), { 'jane@x.co.nz': 'Dr Jane Smith' });
});

test('local part gives a name when nothing better exists', () => {
  assert.deepEqual(byEmail('<p>craig.kirkland@lumino.co.nz</p>'), { 'craig.kirkland@lumino.co.nz': 'Craig Kirkland' });
});

test('generic mailbox gets no name', () => {
  assert.deepEqual(byEmail('<p>Email info@clinic.co.nz today</p>'), { 'info@clinic.co.nz': null });
});

test('Cloudflare data-cfemail is decoded', () => {
  // "info@x.nz" XOR 0x42
  const key = 0x42;
  const hex = key.toString(16) + [...'info@x.nz'].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  assert.ok('info@x.nz' in byEmail(`<span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span>`));
});

test('JSON-LD Person email keeps its name', () => {
  const html = `<script type="application/ld+json">{"@type":"Person","name":"Aroha Smith","email":"mailto:aroha@x.nz"}</script>`;
  assert.deepEqual(byEmail(html), { 'aroha@x.nz': 'Aroha Smith' });
});

test('[at] / (dot) obfuscation', () => {
  assert.ok('reception@clinic.co.nz' in byEmail('<p>reception [at] clinic (dot) co (dot) nz</p>'));
  assert.ok('jo@clinic.co.nz' in byEmail('<p>jo@clinic dot co dot nz</p>'));
  assert.ok('jo@clinic.co.nz' in byEmail('<p>Email jo at clinic dot co dot nz</p>'));
});

test('staff card: heading name is tied to the email in the same card', () => {
  const html = `<div class="card"><h3>Sarah Connor</h3><p>sconnor@clinic.co.nz</p></div>
                <div class="card"><h3>Kyle Reese</h3><p>kreese@clinic.co.nz</p></div>`;
  assert.deepEqual(byEmail(html), { 'sconnor@clinic.co.nz': 'Sarah Connor', 'kreese@clinic.co.nz': 'Kyle Reese' });
});

test('junk emails are dropped', () => {
  assert.deepEqual(byEmail('<img src="logo@2x.png"><p>you@example.com noreply@x.nz 5f2b9a1c3d4e5f6a7b8c9d0e1f2a3b4c@sentry.io</p>'), {});
});

// ---------- performance (H2, M6) ----------

test('long alphanumeric run in raw HTML is linear (H2)', () => {
  const html = `<html><body><p>hi</p><script>var x="${'a'.repeat(1_000_000)}"</script></body></html>`;
  assert.ok(time(() => extractFromHtml(html)) < 1500);
});

test('long whitespace runs from empty tags are linear (H2)', () => {
  const html = `<html><body>${'<div><span></span><i></i></div>'.repeat(2_000)}${' '.repeat(500_000)}${'\n\t'.repeat(100_000)}<p>a@b.co.nz</p></body></html>`;
  let found: string[] = [];
  assert.ok(time(() => { found = extractFromHtml(html).map((f) => f.email); }) < 1500);
  assert.deepEqual(found, ['a@b.co.nz']);
});

test('many emails on a big page are fast (M6)', () => {
  const cards = Array.from({ length: 200 }, (_, i) => `<div class="card"><h3>Person ${i}</h3><p>person${i}@clinic.co.nz</p></div>`).join('');
  const html = `<html><body>${cards}${'<div><p>filler text here</p></div>'.repeat(3000)}</body></html>`;
  let n = 0;
  assert.ok(time(() => { n = extractFromHtml(html).length; }) < 1500);
  assert.equal(n, 200);
});

// ---------- TLDs and ROT13 (H5) ----------

test('real gTLDs outside the old whitelist are kept (H5)', () => {
  for (const e of ['bookings@rotorua.travel', 'sales@kiwi.cars', 'info@dealer.auto', 'info@x.tours', 'jo@x.law', 'a@b.global', 'hi@x.media']) {
    assert.equal(cleanEmail(e), e);
  }
});

test('invalid TLDs are rejected; ROT13-scrambled addresses are decoded (H5)', () => {
  assert.equal(cleanEmail('media@qldairports.com.ay'), null);
  assert.equal(cleanEmail('vasb@onlpvglzbgbetebhc.pbz.nh'), 'info@baycitymotorgroup.com.au');
  assert.equal(cleanEmail('fcbegfzrq@z3pyvavp.pb.am'), 'sportsmed@m3clinic.co.nz'); // ".pb.am" is ROT13 of ".co.nz"
  assert.equal(cleanEmail('info@hotel.am'), 'info@hotel.am'); // a genuine Armenian address stays
});

test('file names are not emails, and ROT13 never revives them', () => {
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('icon@3x.webp'), null);
});

// ---------- names (M1, M2, L2, L3) ----------

test('nameFromLocal only names people (M1)', () => {
  for (const l of ['used.cars', 'parts.department', 'body.shop', 'spare.parts', 'print.room', 'hobart.parts', 'customer.relations',
    'customer.experience', 'trade.res', 'diamondbeach.res', 'travel.carousel', 'soul.events', 'malignant.hyperthermia', 'bec.brisbane']) {
    assert.equal(nameFromLocal(l), null, l);
  }
  for (const [l, n] of [['craig.kirkland', 'Craig Kirkland'], ['julian.park', 'Julian Park'], ['aroha.smith', 'Aroha Smith'], ['priya.patel', 'Priya Patel']]) {
    assert.equal(nameFromLocal(l), n, l);
  }
});

test('a heading only names an email when it matches whole tokens (M2)', () => {
  const near = (name: string, email: string) => byEmail(`<div class="card"><h3>${name}</h3><p>${email}</p></div>`)[email];
  assert.equal(near('Customer Care', 'gmsvcare@gm.com'), null);
  assert.equal(near('Ann Lee', 'annual@x.co.nz'), null);
  assert.equal(near('Sarah Connor', 'sconnor@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Sarah Connor', 'sarahc@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Sarah Connor', 'connor.s@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Dr Amy Wong', 'amy@x.co.nz'), 'Dr Amy Wong');
});

test('personName accepts macrons and accents (L2)', () => {
  assert.equal(personName('Tāne Mahuta'), 'Tāne Mahuta');
  assert.equal(personName('José García'), 'José García');
  assert.equal(personName('Contact Us'), null);
});

test('a name right before a mixed-case email is found (L3)', () => {
  assert.deepEqual(byEmail('<div><p>Kiri Walker <span>Kiri.Walker@Clinic.co.nz</span></p><p>Bob Brown</p></div>'), { 'kiri.walker@clinic.co.nz': 'Kiri Walker' });
});

// ---------- business name (L13) ----------

test('businessName ignores tiny title segments that match the domain (L13)', () => {
  assert.equal(businessName('<title>Home | Auckland Dental | NZ</title>', 'aucklanddentalnz.co.nz'), 'Auckland Dental');
});

// ---------- sources and re-checking cached rows ----------

test('each email records where it was found', () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","email":"a@x.nz"}</script>
    <a href="mailto:b@x.nz">b</a><p>c@x.nz</p><script>var d = "d@x.nz"</script>`;
  assert.deepEqual(Object.fromEntries(extractFromHtml(html).map((f) => [f.email, f.source])), { 'a@x.nz': 'jsonld', 'b@x.nz': 'mailto', 'c@x.nz': 'text', 'd@x.nz': 'raw' });
});

test('recheckRow cleans old cache rows', () => {
  assert.equal(recheckRow({ email: 'media@qldairports.com.ay', name: null }), null);
  assert.deepEqual(recheckRow({ email: 'vasb@onlpvglzbgbetebhc.pbz.nh', name: null }), { email: 'info@baycitymotorgroup.com.au', name: null });
  assert.equal(recheckRow({ email: 'used.cars@x.com.au', name: 'Used Cars' })!.name, null); // old local-part name
  assert.equal(recheckRow({ email: 'gmsvcare@gm.com', name: 'Customer Care' })!.name, null); // all department words
  assert.equal(recheckRow({ email: 'aroha@x.nz', name: 'Aroha Smith' })!.name, 'Aroha Smith'); // scraped name kept
  assert.equal(recheckRow({ email: 'craig.kirkland@lumino.co.nz', name: 'Craig Kirkland' })!.name, 'Craig Kirkland');
});

test('recheckRow leaves fresh results unchanged', () => {
  const html = '<a href="mailto:jane@x.co.nz">Dr Jane Smith</a><p>craig.kirkland@lumino.co.nz info@x.nz</p>';
  for (const f of extractFromHtml(html)) assert.deepEqual(recheckRow(f), f);
});

test('demoteRolePrefixes clears per-branch role mailboxes', () => {
  const cities = ['artarmon', 'blacktown', 'brighton', 'cairns', 'sydney'];
  const rows: Found[] = cities.map((c) => ({ email: `mark.${c}@byd.com.au`, name: `Mark ${c[0].toUpperCase()}${c.slice(1)}` }));
  rows.push({ email: 'rachel.lund@otago.ac.nz', name: 'Rachel Lund' }, { email: 'rachel.elliot@otago.ac.nz', name: 'Rachel Elliot' });
  demoteRolePrefixes(rows);
  assert.deepEqual(rows.map((r) => r.name), [null, null, null, null, null, 'Rachel Lund', 'Rachel Elliot']);
});

test('stop words match whole parts, not substrings', () => {
  assert.equal(nameFromLocal('caroline.ward'), 'Caroline Ward');
  assert.equal(nameFromLocal('dean.williams'), 'Dean Williams');
  assert.equal(nameFromLocal('tina.unitt'), 'Tina Unitt'); // contains the stop word "unit"
  assert.equal(nameFromLocal('mark.helpline'), null);
  assert.equal(nameFromLocal('sarah.recruitment'), null);
});

test('a JSON string escape before an address is not part of it', () => {
  assert.ok('david.xuereb@x.com.au' in byEmail('<script>var s = "Contact:\\ndavid.xuereb@x.com.au";</script>'));
});

test('a page-confirmed name survives re-checking even with an unlisted first name', () => {
  const [row] = extractFromHtml('<div><h3>Perryne Brasko</h3><p>perryne.brasko@x.com.au</p></div><div><h3>Other Person</h3></div>');
  assert.deepEqual(row, { email: 'perryne.brasko@x.com.au', name: 'Perryne Brasko', source: 'text', nameFrom: 'page' });
  assert.equal(recheckRow(row)!.name, 'Perryne Brasko');
});

test('old rows: names the old local-part rule could not produce are treated as page names', () => {
  assert.equal(recheckRow({ email: 'craig.hammermeister@x.com.au', name: 'Craig Hammermeister' })!.name, 'Craig Hammermeister');
  assert.equal(recheckRow({ email: 'rex.xu@x.com.au', name: 'Rex Xu' })!.name, 'Rex Xu');
});

// ---------- audit 2026-10-13 ----------

test('placeholder and platform addresses seen in the caches are dropped (D2)', () => {
  for (const e of ['you@email.com', 'your@email.com', 'jane@email.com', 'info@email.com', 'customer@email.com', 'you@company.com.au',
    'your@business.com', 'jane.smith@test.com.au', 'somethingtotest@test.com.au', 'privacy@squarespace.com', '195123@contactforms.podium.com',
    'privacy@above.com', 'recipient@acme.co.nz', 'name.surname@acme.co.nz', 'info@example.co.nz', 'info@yourcompany.com']) {
    assert.equal(cleanEmail(e), null, e);
  }
  for (const e of ['info@emailmarketing.com.au', 'jo@testsafe.co.nz', 'yolanda@acme.co.nz', 'info@bigbusiness.com.au']) assert.equal(cleanEmail(e), e);
});

test('local parts with a leading, trailing or doubled dot are not addresses (D4)', () => {
  assert.equal(cleanEmail('john..smith@acme.co.nz'), null);
  assert.equal(cleanEmail('john.@acme.co.nz'), null);
  assert.equal(cleanEmail('.john@acme.co.nz'), 'john@acme.co.nz'); // leading punctuation is trimmed, as before
});

test('text glued on after an address does not lose it (B11)', () => {
  assert.deepEqual(findEmails('Email info@acme.co.nzPhone 09 123'), ['info@acme.co.nz']);
  assert.deepEqual(findEmails('sales@acme.comMobile'), ['sales@acme.com']);
  assert.deepEqual(findEmails('INFO@ACME.CO.NZ and Info@Acme.Co.Nz'), ['INFO@ACME.CO.NZ', 'Info@Acme.Co.Nz']);
  assert.deepEqual(Object.keys(byEmail('<p>E: info@acme.co.nzPh: 09 123</p>')), ['info@acme.co.nz']);
});

test('business names drop "Home", "Welcome to" and trailing addresses (D3)', () => {
  assert.equal(tidyBusinessName('Home'), null);
  assert.equal(tidyBusinessName('HOME'), null);
  assert.equal(tidyBusinessName('Welcome to The Denture Place'), 'The Denture Place');
  assert.equal(tidyBusinessName('Home | Panthers Menswear Gippsland'), 'Panthers Menswear Gippsland');
  assert.equal(tidyBusinessName('Welcome to DW Family Doctors, 1/123 Pakuranga Road, Pakuranga, Auckland'), 'DW Family Doctors');
  assert.equal(businessName('<meta property="og:site_name" content="Home"><title>Acme Dental | Home</title>', 'acmedental.co.nz'), 'Acme Dental');
  assert.equal(businessName('<title>Home</title>', 'www.acme.co.nz'), 'acme.co.nz');
});

// ---------- name rules (2026-11-11 audit: the same name on many unrelated emails) ----------

test('localName: junk, role mailboxes, people and other words', () => {
  const k = (l: string, d = 'acme.com.au') => localName(l, d);
  assert.equal(k('0zbi').kind, 'junk');
  assert.equal(k('279942079').kind, 'junk');
  assert.equal(k('bss').kind, 'junk'); // no vowel
  assert.equal(k('info').kind, 'generic');
  assert.equal(k('admin').kind, 'generic');
  assert.deepEqual(k('sales'), { kind: 'role', text: 'Sales' });
  assert.deepEqual(k('customer.service'), { kind: 'role', text: 'Customer Service' });
  assert.deepEqual(k('customerservice'), { kind: 'role', text: 'Customer Service' });
  assert.deepEqual(k('paul.wu'), { kind: 'person', text: 'Paul Wu' });
  assert.deepEqual(k('rachel.b'), { kind: 'person', text: 'Rachel B' });
  assert.deepEqual(k('vicki.j.cunningham'), { kind: 'person', text: 'Vicki J Cunningham' });
  assert.deepEqual(k('johnh'), { kind: 'person', text: 'John H' });
  assert.deepEqual(k('alex'), { kind: 'person', text: 'Alex' });
  assert.deepEqual(k('jane.smith7'), { kind: 'person', text: 'Jane Smith' });
  assert.deepEqual(k('geebung'), { kind: 'words', text: 'Geebung' });
  assert.deepEqual(k('customer.relations'), { kind: 'words', text: 'Customer Relations' });
  assert.deepEqual(k('meredithwilson67', 'gmail.com'), { kind: 'person', text: 'Meredith Wilson' }); // a given name and a surname run together
  assert.deepEqual(k('jsmith'), { kind: 'person', text: 'J Smith' });
  assert.deepEqual(k('lynfieldfitness'), { kind: 'words', text: 'Lynfield Fitness' });
  assert.deepEqual(k('thomastown'), { kind: 'words', text: 'Thomastown' }); // a suburb, not Thomas Town
  assert.deepEqual(k('senator.smith'), { kind: 'words', text: 'Senator Smith' }); // a role word, not a first name
});

test('a lone given name is a person unless it is a place or echoes the email domain', () => {
  assert.equal(nameFromLocal('preston', 'prestonmazda.com.au'), null);
  assert.equal(nameFromLocal('preston', 'x.com.au'), null); // a suburb as well
  assert.equal(nameFromLocal('sydney', 'x.com.au'), null);
  assert.equal(nameFromLocal('alex', 'austyrenautomotive.com.au'), 'Alex');
  assert.equal(nameFromLocal('mark.au', 'x.com.au'), null);
  assert.equal(nameFromLocal('tom.it', 'x.com.au'), null);
});

test('a title alone does not tie a name to a role mailbox or another person (P1, P2)', () => {
  const near = (name: string, email: string) => byEmail(`<div class="card"><h3>${name}</h3><p>${email}</p></div>`)[email];
  assert.equal(near('Mr Matt Baxter', 'bishop@dow.org.au'), null);
  assert.equal(near('Mr Matt Baxter', 'vicar.general@dow.org.au'), null);
  assert.equal(near('Dr Amy Wong', 'john@x.co.nz'), 'John'); // not Amy: the heading is someone else's, the name comes from the address
  assert.equal(near('Mr Michael Crandon', 'coomera@parliament.qld.gov.au'), 'Mr Michael Crandon'); // an electorate mailbox
  assert.equal(near('Vice President', 'president@club.org.au'), null); // role words don't match
  assert.equal(near('Mr Matt Baxter', 'matt.baxter@dow.org.au'), 'Mr Matt Baxter');
});

test('recheckRow drops an old page name that no longer matches its email (P1)', () => {
  assert.equal(recheckRow({ email: 'bishop@dow.org.au', name: 'Mr Matt Baxter', source: 'mailto', nameFrom: 'page' })!.name, null);
  assert.equal(recheckRow({ email: 'bishop@dow.org.au', name: 'Mr Matt Baxter', source: 'jsonld', nameFrom: 'page' })!.name, 'Mr Matt Baxter');
});

test('one page name on several emails stays only on those that match it (P3)', () => {
  const rows: Found[] = [
    { email: 'bishop@dow.org.au', name: 'Mr Matt Baxter', source: 'mailto', nameFrom: 'page' },
    { email: 'matt.baxter@dow.org.au', name: 'Mr Matt Baxter', source: 'mailto', nameFrom: 'page' },
    { email: 'cwilkins@a.co.nz', name: 'Chris Wilkins', source: 'mailto', nameFrom: 'page' },
    { email: 'cwilkins@b.co.nz', name: 'Chris Wilkins', source: 'mailto', nameFrom: 'page' },
    { email: 'who@x.nz', name: 'Solo Person', source: 'mailto', nameFrom: 'page' },
  ];
  demoteSharedPageNames(rows);
  assert.deepEqual(rows.map((r) => r.name), [null, 'Mr Matt Baxter', 'Chris Wilkins', 'Chris Wilkins', 'Solo Person']);
});

test('a JSON-LD Person names only its own emails, an array included', () => {
  const html = `<script type="application/ld+json">{"@type":"Person","name":"Aroha Smith","email":["aroha@x.nz","mailto:a.smith@x.nz"]}</script>
    <p>info@x.nz bob@x.nz</p><a href="mailto:bob@x.nz">Bob Jones</a>
    <script type="application/ld+json">{"@type":"Organization","name":"X Ltd","email":"office@x.nz"}</script>`;
  assert.deepEqual(byEmail(html), { 'aroha@x.nz': 'Aroha Smith', 'a.smith@x.nz': 'Aroha Smith', 'info@x.nz': null, 'bob@x.nz': 'Bob Jones', 'office@x.nz': null });
});

test('a microdata Person names all its own emails and nothing inside a nested item', () => {
  const html = `<div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Jo Bloggs</span>
      <a itemprop="email" href="mailto:jo@x.nz">jo@x.nz</a> <span itemprop="email">jo.bloggs@x.nz</span>
      <div itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Acme Ltd</span><span itemprop="email">sales@acme.nz</span></div></div>
    <p>other@x.nz</p>`;
  assert.deepEqual(byEmail(html), { 'jo@x.nz': 'Jo Bloggs', 'jo.bloggs@x.nz': 'Jo Bloggs', 'sales@acme.nz': null, 'other@x.nz': null });
});

test('business names skip bot-check titles, URLs, phone numbers and SEO tails', () => {
  assert.equal(tidyBusinessName('Just a moment...'), null);
  assert.equal(tidyBusinessName('One moment, please...'), null);
  assert.equal(tidyBusinessName('Access Denied'), null);
  assert.equal(tidyBusinessName('https://www.jackowheels.net.au/'), null);
  assert.equal(tidyBusinessName('Home » Joseph Radiators and Air Conditioning'), 'Joseph Radiators and Air Conditioning');
  assert.equal(tidyBusinessName('Muay Thai Melbourne Call 0433 568 256'), 'Muay Thai Melbourne');
  assert.equal(tidyBusinessName('New Cars Toyota Australia: Prices, Service Centres, Dealers, Test Drives'), 'New Cars Toyota Australia');
  assert.equal(businessName('<title>Just a moment...</title>', 'www.acme.co.nz'), 'acme.co.nz');
});

test('business name falls back to the logo text, then the footer copyright', () => {
  assert.equal(businessName('<title>Contact</title><header><img class="site-logo" src="/l.png" alt="Bay Motors logo"></header>', 'x.nz'), 'Bay Motors');
  assert.equal(businessName('<title>Contact</title><footer>© 2024 Bay Motors Pty Ltd. All rights reserved.</footer>', 'x.nz'), 'Bay Motors');
  assert.equal(businessName('<title>Bay Motors | Contact</title><footer>© 2024 Other Name</footer>', 'baymotors.nz'), 'Bay Motors'); // a domain match wins
});
