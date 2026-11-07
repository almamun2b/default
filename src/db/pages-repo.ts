import fs from 'node:fs';
import type { Found } from '../extract.js';
import { log } from '../logger.js';
import { hashOf, HashIndex, type IndexEntry } from './hash-index.js';
import { ensureTrailingNewline, openAppend, parseHead, readAt, scanLines, writeAll } from './jsonl.js';

/**
 * What one fetched page yielded, independent of the site that fetched it: any site of any category that reaches
 * the page again takes this instead of requesting it (a page is scraped once, ever).
 */
export interface PageRecord {
  url: string; // the page's final URL after redirects
  emails: Found[];
  title?: string; // the page's <h1> or <title> as a department name, when it has a usable one
  links: string[]; // crawlable same-site links, each page once; same-origin ones as path + query, resolved against `url`
  at: number; // when the page was fetched or last revalidated (epoch ms)
  etag?: string; // validators the server gave, to revalidate the page with a conditional request
  lastModified?: string;
}

/** `http`: fetched with plain HTTP; `browser`: rendered by Chromium (it sees what HTTP can't, so the two never stand in for each other). */
export type Mode = 'http' | 'browser';
export type Loaded = { rec: PageRecord; reused: boolean } | 'gone' | null;

/** Who fetched a page, stored with it. `cat` and `list` are null for pages imported from before the db existed. */
export interface Provenance {
  cat: string | null;
  list: string | null;
  run: string;
  site?: string | null; // the input website whose crawl fetched the page
}

/** What the crawler uses: the store as seen by one crawl (it knows who is asking). */
export interface PagesView {
  readonly pages: number;
  /** The same store with the pages it stores credited to this input website. */
  withSite(site: string): PagesView;
  get(mode: Mode, key: string): PageRecord | undefined;
  put(mode: Mode, key: string, rec: PageRecord, cutoff?: number): void;
  markGone(mode: Mode, key: string, at?: number): void;
  load(mode: Mode, key: string, cutoff: number, fetch: (stale?: PageRecord) => Promise<PageRecord | null>): Promise<Loaded>;
  sitemap(origin: string, load: () => Promise<string[]>, complete: () => boolean): Promise<string[]>;
}

export interface PagesFiles {
  data: string; // results/db/pages.jsonl
  index: string; // results/db/pages.idx
}

/** Record schema version written to pages.jsonl. */
export const PAGE_RECORD_VERSION = 1;

const BODY = Buffer.from(',"d":');
const CHECKPOINT_EVERY = 20_000; // appends between durable index checkpoints
const AVG_RECORD_BYTES = 1500; // sizes a fresh index from the data file

const j = (v: string | null | undefined) => JSON.stringify(v ?? null);
const idOf = (mode: Mode, key: string) => `${mode}\0${key}`;
/** The host part of a page key (`example.com/a?b` -> `example.com`). */
export const hostOfKey = (key: string) => key.split(/[/?]/, 1)[0];

/** The start of every record of this page: the identifiers an index needs, and what a lookup checks to be sure of its hit. */
const headOf = (mode: Mode, key: string) => `{"v":${PAGE_RECORD_VERSION},"k":${JSON.stringify(key)},"m":"${mode}","a":`;

function envelope(mode: Mode, key: string, at: number, p: Provenance): string {
  return `${headOf(mode, key)}${at},"host":${j(hostOfKey(key))},"cat":${j(p.cat)},"list":${j(p.list)},"site":${j(p.site)},"run":${j(p.run)}`;
}

/** The line for a fetched page; `bodyJson` is the PageRecord as JSON. */
export const pageLine = (mode: Mode, key: string, at: number, p: Provenance, bodyJson: string) => `${envelope(mode, key, at, p)},"d":${bodyJson}}`;
/** The line for a page that answered 404/410. */
export const goneLine = (mode: Mode, key: string, at: number, p: Provenance) => `${envelope(mode, key, at, p)},"gone":1}`;

/**
 * Every page ever visited, in `results/db/pages.jsonl` (append-only; the newest record of a (mode, key) wins) with
 * a persistent hash index beside it, `pages.idx`, so opening needs no scan and a lookup is two positional reads.
 * A line is `{"v":1,"k":<pageKey>,"m":<mode>,"a":<at>,"host":..,"cat":..,"list":..,"site":..,"run":..,"d":<PageRecord>}`
 * (or `"gone":1` instead of `d` for a 404/410): the identifiers come first so the index is built without parsing
 * bodies, and the provenance says which category/list/site/run fetched that version of the page.
 *
 * One writer at a time (the caller holds results/db/locks/pages.lock). Records
 * are read back on demand, so memory holds nothing per page.
 */
export class PagesRepo {
  private idx: HashIndex;
  private readFd: number | null = null;
  private writeFd: number | null = null;
  private size = 0;
  private sinceCheckpoint = 0;
  private readonly bad = new Set<string>(); // records that failed to read back this run: fetched again
  private readonly inflight = new Map<string, Promise<PageRecord | null>>();
  private readonly sitemaps = new Map<string, Promise<string[]>>(); // this run only: a sitemap is a handful of requests

  constructor(private readonly files: PagesFiles) {
    ensureTrailingNewline(files.data);
    this.writeFd = openAppend(files.data);
    this.size = fs.fstatSync(this.writeFd).size;
    this.idx = HashIndex.open(files.index, Math.ceil(this.size / AVG_RECORD_BYTES));
    this.catchUp();
  }

  /** Distinct pages (and known 404s) in the store. */
  get pages(): number { return this.idx.count; }

  /** Indexes whatever the data file holds past what the index covers: all of it for a new index, a crash's leftovers otherwise. */
  private catchUp(): void {
    const from = this.idx.fresh ? 0 : this.idx.indexedBytes;
    if (from > this.size) { // the data is shorter than the index claims: the index is not for this file
      log.warn({ index: this.files.index }, 'pages.idx does not match pages.jsonl; rebuilding it');
      this.idx.close();
      fs.rmSync(this.files.index, { force: true });
      this.idx = HashIndex.open(this.files.index, Math.ceil(this.size / AVG_RECORD_BYTES));
      return this.catchUp();
    }
    if (from >= this.size) return;
    const t0 = Date.now();
    if (from === 0 && this.size > (64 << 20)) log.info({ bytes: this.size }, `building the page index over ${(this.size / 2 ** 30).toFixed(1)} GB of pages (once)`);
    let added = 0;
    const end = scanLines(this.files.data, from, (data, s, e, off) => { if (this.indexLine(data, s, e, off)) added++; });
    this.idx.flush(end);
    if (this.size - from > (64 << 20)) log.info({ pages: added, ms: Date.now() - t0 }, `page index ready: ${this.idx.count} pages`);
  }

  private indexLine(data: Buffer, s: number, e: number, off: number): boolean {
    if (data[e - 1] !== 0x7d) return false; // a complete record ends with `}`: this one was cut off
    const h = parseHead(data, s, e, BODY);
    if (!h || typeof h.k !== 'string' || (h.m !== 'http' && h.m !== 'browser') || typeof h.a !== 'number') return false;
    const mode = h.m, key = h.k;
    const entry: IndexEntry = { offset: off, length: e - s, at: h.a, gone: h.gone === 1 };
    return this.idx.set(hashOf(idOf(mode, key)), entry, (x) => this.isRecordOf(x, mode, key)) !== 'kept';
  }

  /** Whether the record at `x` is for this (mode, key), not just a page with the same 64-bit hash. */
  private isRecordOf(x: IndexEntry, mode: Mode, key: string): boolean {
    const head = headOf(mode, key);
    const buf = this.readBytes(x.offset, Math.min(x.length, Buffer.byteLength(head)));
    return !!buf && buf.toString('utf8') === head;
  }

  private readBytes(offset: number, length: number): Buffer | undefined {
    try {
      this.readFd ??= fs.openSync(this.files.data, 'r');
      return readAt(this.readFd, offset, length);
    } catch {
      return undefined;
    }
  }

  private entry(mode: Mode, key: string): IndexEntry | undefined {
    if (this.bad.has(idOf(mode, key))) return undefined;
    return this.idx.get(hashOf(idOf(mode, key)), (x) => this.isRecordOf(x, mode, key));
  }

  private read(mode: Mode, key: string, e: IndexEntry): PageRecord | undefined {
    if (e.gone) return undefined;
    try {
      const buf = this.readBytes(e.offset, e.length);
      if (buf) return (JSON.parse(buf.toString('utf8')) as { d: PageRecord }).d;
    } catch { /* fall through */ }
    this.bad.add(idOf(mode, key)); // unreadable record: the page is fetched again
    return undefined;
  }

  private append(mode: Mode, key: string, at: number, line: string, gone: boolean): void {
    if (this.writeFd === null) throw new Error('the page store is closed');
    const buf = Buffer.from(line + '\n');
    writeAll(this.writeFd, buf);
    const entry: IndexEntry = { offset: this.size, length: buf.length - 1, at, gone };
    this.size += buf.length;
    this.idx.set(hashOf(idOf(mode, key)), entry, (x) => this.isRecordOf(x, mode, key));
    this.idx.indexedBytes = this.size;
    this.bad.delete(idOf(mode, key));
    if (++this.sinceCheckpoint >= CHECKPOINT_EVERY) this.checkpoint();
  }

  /** Makes everything written so far durable before the index claims it covers it. */
  checkpoint(): void {
    if (this.writeFd !== null) fs.fsyncSync(this.writeFd);
    this.idx.flush(this.size);
    this.sinceCheckpoint = 0;
  }

  /** A view of the store for one crawl: what it stores is credited to `who`. */
  view(who: Provenance): PagesView {
    const repo = this;
    return {
      get pages() { return repo.pages; },
      withSite: (site) => repo.view({ ...who, site }),
      get: (mode, key) => repo.getRecord(mode, key),
      put: (mode, key, rec, cutoff = Infinity) => repo.putRecord(who, mode, key, rec, cutoff),
      markGone: (mode, key, at = Date.now()) => repo.append(mode, key, at, goneLine(mode, key, at, who), true),
      load: (mode, key, cutoff, fetch) => repo.loadRecord(who, mode, key, cutoff, fetch),
      sitemap: (origin, load, complete) => repo.sitemap(origin, load, complete),
    };
  }

  /** When the stored copy of a page was fetched; undefined if the store has none. */
  has(mode: Mode, key: string): number | undefined {
    return this.entry(mode, key)?.at;
  }

  /** The stored copy of a page, whatever its age (undefined if none, or if it is a known 404). */
  getRecord(mode: Mode, key: string): PageRecord | undefined {
    const e = this.entry(mode, key);
    return e && this.read(mode, key, e);
  }

  /** Stores `rec`, replacing an older copy; a copy at least as new as `cutoff` stays (a landing page, requested anyway). */
  putRecord(who: Provenance, mode: Mode, key: string, rec: PageRecord, cutoff = Infinity): void {
    const e = this.entry(mode, key);
    if (!e || e.at < cutoff) this.append(mode, key, rec.at, pageLine(mode, key, rec.at, who, JSON.stringify(rec)), false);
  }

  /**
   * The page for `key`: from the store when its copy is not older than `cutoff`, from a fetch another site has
   * under way right now (waited for), or from `fetch`, whose result is stored. `fetch` gets the older copy of a
   * stale page, to revalidate it. `reused` says the page did not come from `fetch`. A page nobody could fetch is
   * null (sites that waited on a failed fetch try it themselves); 'gone' is a 404/410.
   */
  async loadRecord(who: Provenance, mode: Mode, key: string, cutoff: number, fetch: (stale?: PageRecord) => Promise<PageRecord | null>): Promise<Loaded> {
    const id = idOf(mode, key);
    for (;;) {
      const e = this.entry(mode, key);
      if (e && e.at >= cutoff) {
        if (e.gone) return 'gone';
        const rec = this.read(mode, key, e);
        if (rec) return { rec, reused: true };
        continue; // unreadable, now skipped
      }
      const flying = this.inflight.get(id);
      if (!flying) break;
      const rec = await flying;
      if (rec) return { rec, reused: true };
    }
    const stale = this.entry(mode, key);
    const p = fetch(stale && this.read(mode, key, stale));
    this.inflight.set(id, p.catch(() => null)); // a crash in this fetch must not reject the sites waiting on it
    try {
      const rec = await p;
      if (!rec) {
        const e = this.entry(mode, key);
        return e?.gone && e.at >= cutoff ? 'gone' : null;
      }
      this.append(mode, key, rec.at, pageLine(mode, key, rec.at, who, JSON.stringify(rec)), false);
      return { rec, reused: false };
    } finally {
      this.inflight.delete(id);
    }
  }

  /** An origin's sitemap URLs, requested once per run. A load that was cut short is not kept. */
  sitemap(origin: string, load: () => Promise<string[]>, complete: () => boolean): Promise<string[]> {
    let p = this.sitemaps.get(origin);
    if (!p) {
      p = load();
      this.sitemaps.set(origin, p);
      p.then(() => { if (!complete()) this.sitemaps.delete(origin); }, () => this.sitemaps.delete(origin));
    }
    return p;
  }

  /**
   * Adds a page from an older store (the importer). Skipped when the store already has a copy at least as new, so
   * importing twice, or the same page from two categories, keeps one. Returns whether the line was written.
   */
  importLine(mode: Mode, key: string, at: number, line: string, gone: boolean): boolean {
    const e = this.entry(mode, key);
    if (e && e.at >= at) return false;
    this.append(mode, key, at, line, gone);
    return true;
  }

  close(): void {
    if (this.writeFd !== null) this.checkpoint();
    this.idx.close();
    for (const fd of [this.readFd, this.writeFd]) if (fd !== null) fs.closeSync(fd);
    this.readFd = this.writeFd = null;
  }
}
