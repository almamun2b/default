import { getDomain } from 'tldts';
import type { FoundOnPage, SiteResult } from './crawler.js';
import { DEPT_WORDS, demoteRolePrefixes, demoteSharedPageNames, isFreeMail, localName, recheckRow, tidyBusinessName } from './extract.js';
import type { Db } from './db/open.js';
import { inSection, isContactPage, sectionPrefix } from './urls.js';
import { nameFromDomain } from './words.js';

export type Row = [name: string, email: string, website: string, link: string];

/**
 * Neutralises spreadsheet formulas. Names come from third-party page titles, so a site titled
 * "=HYPERLINK(...)" would otherwise become a live formula when the CSV is opened in Excel or Sheets.
 */
export function safeCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * A stored result with the current email and name rules re-applied (see recheckRow). Fresh results pass
 * through unchanged; cached ones from older code get cleaned. The cache itself is never rewritten.
 */
export function recheckSite(r: SiteResult): SiteResult {
  const byEmail = new Map<string, FoundOnPage>();
  for (const e of r.emails) {
    const c = recheckRow(e);
    if (!c) continue;
    const prev = byEmail.get(c.email); // a ROT13 decode can land on an address already found
    if (!prev || (!prev.name && c.name)) byEmail.set(c.email, c);
  }
  const emails = [...byEmail.values()];
  demoteRolePrefixes(emails);
  demoteSharedPageNames(emails);
  let business = r.business;
  try {
    business = tidyBusinessName(r.business) ?? new URL(r.finalUrl).hostname.replace(/^www\./, '');
  } catch { /* keep */ }
  return { ...r, business, emails };
}

/** Registrable domain ("mail.acme.co.nz" → "acme.co.nz"), else the host itself. A bogus suffix ("x.or.nz" → "or.nz") keeps the label before it. */
const regDomain = (host: string): string => {
  const h = host.toLowerCase();
  const d = getDomain(h, { allowPrivateDomains: false });
  if (!d) return h;
  const labels = h.split('.');
  // "x.or.nz": tldts has no "or.nz" suffix, so it answers "or.nz"; the name is the label before it
  return /^(co|or|org|net|com|gov|govt|edu|ac|ne|id|asn)\.[a-z]{2}$/.test(d) && labels.length > 2 ? labels.slice(-3).join('.') : d;
};
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

/** Which rule gave a row its name, for the summary. */
export type NameKind = 'person' | 'department' | 'input' | 'business' | 'mailbox' | 'domain';

export interface Assigned {
  rows: Row[]; // the per-file CSV: unique by email, ordered by the credited site's place in the input
  kinds: Record<NameKind, number>; // name source of each row in `rows`
  redirects: string[]; // "input host → landing host" of sites whose landing page is on an unrelated domain
}

const url = (u: string | undefined): URL | null => { try { return u ? new URL(u) : null; } catch { return null; } };
const letters3 = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 4 && !DEPT_WORDS.has(t)); // words of 4+ letters that are not roles
const HOSTLIKE = /^[\w.-]+\.[a-z]{2,}$/i; // a business name that is only the site's host: nothing was found on the page
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether two registrable domains (or the second and the input's own name) plausibly belong to one business. */
function related(a: string, b: string, name?: string): boolean {
  if (a === b) return true;
  const la = letters(a.split('.')[0]), lb = letters(b.split('.')[0]);
  if (la.length >= 4 && lb.length >= 4 && (la.includes(lb) || lb.includes(la))) return true;
  return (name ?? '').toLowerCase().split(/[^a-z0-9]+/).some((t) => t.length >= 5 && lb.includes(t));
}

// The business name of every site ever scraped, by registrable domain: names another company's email by what we know of it.
let domainBusiness = new Map<string, string>();
let domainBusinessLoaded = false;

/** Reads the stored results once per process (`db`: results/db). Newest good name wins; a landing page's name belongs to its own domain. */
export function loadDomainBusiness(db: Db, force = false): void {
  if (domainBusinessLoaded && !force) return;
  domainBusinessLoaded = true;
  const map = new Map<string, string>();
  db.sites.scanRows((row) => {
    const r = row.result;
    const b = r && tidyBusinessName(r.business ?? '');
    if (!r || !b || HOSTLIKE.test(b)) return;
    const start = url(row.site), end = url(r.finalUrl);
    if (start && end && sectionPrefix(start, end)) return; // the name is of a section's page (a minister's page on a government site), not of the whole site
    const input = regDomain(hostOf(row.site)), landing = regDomain(hostOf(r.finalUrl));
    map.set(landing, b);
    if (input !== landing && related(input, landing)) map.set(input, b);
  });
  domainBusiness = map;
}

/** What the output needs to know about one input site to name its emails. */
interface SiteCtx {
  labels: Set<string>; // first labels of own domains: smashtennis.co.nz on smashtennis.nz is the same business
  own: Set<string>; // registrable domains that are the site's own (a landing page on an unrelated domain isn't, unless it is a section)
  section: string | null; // path prefix when the input is one section of a bigger site
  input: string | undefined; // the input file's own name for the site
  business: string; // scraped business name
  hostDomain: string;
  free: number; // free-mail addresses on the site
  titled: Map<string, number>; // emails per page that carry a department title
  away: boolean; // the landing page is on an unrelated domain and not a section of it
}

function siteContext(site: string, r: SiteResult, input: string | undefined): SiteCtx {
  const inputDomain = regDomain(hostOf(site)), finalDomain = regDomain(hostOf(r.finalUrl));
  const landing = url(r.finalUrl), start = url(site);
  const section = landing && start ? sectionPrefix(start, landing) : null;
  // A redirect into a section of another site (a hospital page on a health board's site) is still the input's own.
  const away = !related(inputDomain, finalDomain, input) && !section;
  const titled = new Map<string, number>();
  let free = 0;
  for (const e of r.emails) {
    if (isFreeMail(e.email.slice(e.email.indexOf('@') + 1))) free++;
    if (e.pageTitle && e.link) titled.set(e.link, (titled.get(e.link) ?? 0) + 1);
  }
  const own = new Set(away ? [inputDomain] : [inputDomain, finalDomain]);
  return {
    own, labels: new Set([...own].map((d) => d.split('.')[0]).filter((l) => l.length >= 4)),
    section,
    input, business: HOSTLIKE.test(r.business) ? nameFromDomain(inputDomain) : r.business, hostDomain: inputDomain, free, titled, away,
  };
}

/**
 * Whether `domain` (registrable) is the site's own. `host` is the full email host: a label in front of the registrable
 * domain that is the site's own name ("northshorecountryclub.0rg.au", a mistyped ".org.au" on northshorecountryclub.com.au) counts too.
 */
const isOwn = (ctx: SiteCtx, domain: string, host = domain) =>
  ctx.own.has(domain) || ctx.labels.has(domain.split('.')[0]) ||
  host.toLowerCase().split('.').slice(0, -domain.split('.').length).some((l) => ctx.labels.has(l));

/** "Org - Local", or just Org when the local part only repeats it. */
const withLocal = (org: string, local: string) => (letters(org).includes(letters(local)) || letters(local).includes(letters(org)) ? org : `${org} - ${local}`);

/**
 * The output rows for one input file. Each email appears once and is credited to the site that owns it: the
 * first site whose registrable domain is the email's, else the first site where it wasn't only in raw HTML
 * (scripts, data blobs), else the first site.
 *
 * The name, never blank: a person (read off the page, or the local part when it is a given name), else the
 * business the email belongs to — the site's own for its own domain (and for a free-mail address on its contact
 * pages), the list's site owning the domain or the domain itself for another company's address — with a branch or
 * department mailbox appended ("Acme Electrical - Geebung"). Role mailboxes (info@, sales@) take the business
 * alone, or the department page title on a section's sub-page.
 */
export function assignRows(sites: string[], done: Map<string, SiteResult>, inputNames: Map<string, string> = new Map()): Assigned {
  type Seen = { si: number; ei: number; site: string; r: SiteResult; e: FoundOnPage };
  const byEmail = new Map<string, Seen[]>();
  const ctxs = new Map<string, SiteCtx>();
  const listed = new Map<string, { name: string; kind: 'input' | 'business' }>(); // a list site per registrable domain
  const redirects: string[] = [];
  const crowd = new Map<string, number>(); // list sites per registrable domain: many means a shared host (one page per MP or dealer), not one business
  sites.forEach((site, si) => {
    const r = done.get(site);
    if (!r) return;
    const ctx = siteContext(site, r, inputNames.get(site));
    ctxs.set(site, ctx);
    crowd.set(ctx.hostDomain, (crowd.get(ctx.hostDomain) ?? 0) + 1);
    const root = url(site)?.pathname.replace(/\/+$/, '') === ''; // an input deeper in a site (one MP's page) doesn't name the whole domain
    if (root) for (const d of ctx.own) if (!listed.has(d)) listed.set(d, ctx.input ? { name: ctx.input, kind: 'input' } : { name: ctx.business, kind: 'business' });
    if (ctx.away && r.emails.length) redirects.push(`${hostOf(site).replace(/^www\./, '')} → ${hostOf(r.finalUrl).replace(/^www\./, '')}`);
    r.emails.forEach((e, ei) => {
      const list = byEmail.get(e.email) ?? [];
      list.push({ si, ei, site, r, e });
      byEmail.set(e.email, list);
    });
  });

  const nameOf = (pick: Seen): { name: string; kind: NameKind } => {
    const { e, site } = pick, ctx = ctxs.get(site)!;
    if (e.name) return { name: e.name, kind: 'person' };
    const at = e.email.indexOf('@');
    const domain = e.email.slice(at + 1), edom = regDomain(domain);
    const local = localName(e.email.slice(0, at), domain);
    if (local.kind === 'person') return { name: local.text!, kind: 'person' };

    const link = url(e.link);
    const inSect = !!(ctx.section && link && inSection(link, ctx.section));
    const linkOwn = !!link && (isOwn(ctx, regDomain(link.hostname), link.hostname) || inSect);
    // the site's own name for the business: the input's; outside the section it was given for, the whole domain's (never the section's name)
    const siteOrg = (d: string): { name: string; kind: NameKind } => {
      if (ctx.input && (!ctx.section || inSect || !linkOwn)) return { name: ctx.input, kind: 'input' };
      if (ctx.section && !inSect) {
        const known = domainBusiness.get(d);
        return known ? { name: known, kind: 'business' } : { name: nameFromDomain(d), kind: 'domain' };
      }
      return ctx.business ? { name: ctx.business, kind: 'business' } : { name: nameFromDomain(ctx.hostDomain), kind: 'domain' };
    };
    let org: { name: string; kind: NameKind } | null = null;
    let siteOwn = false;
    if (isOwn(ctx, edom, domain)) {
      // On a host shared by many list sites the input name of the site an email is credited to names it only when they share a word
      const mine = new Set(letters3(ctx.input ?? ''));
      const shared = (crowd.get(edom) ?? 0) >= 3 && !letters3(e.email.slice(0, at)).some((t) => mine.has(t));
      const known = domainBusiness.get(edom);
      org = shared ? (known ? { name: known, kind: 'business' } : { name: nameFromDomain(edom), kind: 'domain' }) : siteOrg(edom);
      siteOwn = true;
    }
    else if (isFreeMail(domain) || isFreeMail(edom)) {
      // a free-mail address is the business's own on its home/contact pages, or when it is one of very few
      if (linkOwn && link && (isContactPage(link) || ctx.free <= 2)) { org = siteOrg(regDomain(link.hostname)); siteOwn = true; }
    } else {
      // another company's address: the list's own site for its domain, else a site of it scraped for any list, else its domain as words
      const known = domainBusiness.get(edom);
      org = listed.get(edom) ?? (known ? { name: known, kind: 'business' } : { name: nameFromDomain(edom), kind: 'domain' });
    }

    if (local.kind === 'words') return org ? { name: withLocal(org.name, local.text!), kind: 'mailbox' } : { name: local.text!, kind: 'mailbox' };
    if (local.kind === 'role' && org) return { name: withLocal(org.name, local.text!), kind: 'mailbox' };
    if (!org) return { name: domain, kind: 'domain' };
    if (siteOwn && e.pageTitle && (ctx.titled.get(e.link ?? '') ?? 0) <= 3) return { name: e.pageTitle, kind: 'department' };
    return org;
  };

  const main: (Seen & { row: Row })[] = [];
  const kinds: Record<NameKind, number> = { person: 0, department: 0, input: 0, business: 0, mailbox: 0, domain: 0 };
  for (const [email, seen] of byEmail) {
    const host = email.slice(email.indexOf('@') + 1), own = regDomain(host);
    const owner = seen.find((x) => isOwn(ctxs.get(x.site)!, own, host));
    const pick = owner ?? seen.find((x) => x.e.source !== 'raw') ?? seen[0];
    const { name, kind } = nameOf(pick);
    const row: Row = [safeCell(name || email.slice(email.indexOf('@') + 1)), email, pick.r.site, pick.e.link ?? ''];
    main.push({ ...pick, row });
    kinds[kind]++;
  }
  main.sort((a, b) => a.si - b.si || a.ei - b.ei);
  return { rows: main.map((m) => m.row), kinds, redirects };
}

/**
 * One row per email across several output CSVs (input lists overlap, so the same address shows up in many
 * files). Files are taken in the given order and the first occurrence wins, like buildRows within one file.
 */
export function uniqueRows(files: { base: string; rows: Row[] }[]): { rows: Row[]; read: number; overlaps: Map<string, number> } {
  const rows: Row[] = [];
  const firstIn = new Map<string, string>();
  const overlaps = new Map<string, number>(); // "later file ← first file" → duplicates dropped
  let read = 0;
  for (const f of files) {
    for (const row of f.rows) {
      read++;
      const key = row[1].trim().toLowerCase();
      const first = firstIn.get(key);
      if (first !== undefined) {
        if (first !== f.base) overlaps.set(`${f.base} ← ${first}`, (overlaps.get(`${f.base} ← ${first}`) ?? 0) + 1);
        continue;
      }
      firstIn.set(key, f.base);
      rows.push(row);
    }
  }
  return { rows, read, overlaps };
}

/** Name for a combined file: the prefix all base names share before their first `.`, `_` or `-` (`au.x`, `au.y` → `au`), else `all`. */
export function uniqueLabel(bases: string[]): string {
  const heads = new Set(bases.map((b) => b.split(/[._-]/)[0]));
  const [head] = heads;
  return heads.size === 1 && head ? head : 'all';
}
