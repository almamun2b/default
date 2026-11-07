import fs from 'node:fs';
import type { SiteResult } from '../crawler.js';
import { log } from '../logger.js';
import { ensureTrailingNewline, openAppend, parseHead, readAt, scanLines, writeAll } from './jsonl.js';
import { writeFileAtomic } from './lock.js';

export interface SitesFiles {
  data: string; // results/db/sites.jsonl
  index: string; // results/db/sites.idx
}

/** Which scrape of which list a site result belongs to. */
export interface ListRef {
  cat: string;
  list: string;
  g: number; // generation: a fresh re-scrape of a list opens the next one
  run: string;
}

/** A record of sites.jsonl. */
export interface SiteRow extends ListRef {
  v: number;
  t: 'site' | 'drop';
  a: number; // when it was written (epoch ms)
  site: string;
  r?: SiteResult; // absent on a `drop`
}

/** Record schema version written to sites.jsonl. */
export const SITE_ROW_VERSION = 1;

const BODY = Buffer.from(',"r":');
const SNAPSHOT_AFTER = 4 << 20; // bytes read past the saved index before it is saved again

type Loc = { offset: number; length: number };
type ListIdx = { g: number; sites: Map<string, Loc> };
const listKey = (cat: string, list: string) => `${cat}\0${list}`;

/**
 * The result of every site of every list, in `results/db/sites.jsonl`, one record per line, append-only:
 * `{"v":1,"t":"site","cat":..,"list":..,"g":..,"run":..,"a":..,"site":..,"r":<SiteResult>}`. Within the newest
 * generation of a list the last record of a site wins, and a `drop` record (`"t":"drop"`) removes it again (a
 * retry that crawls a failed site afresh drops the old row so an interrupted retry still redoes it). Earlier
 * generations stay on disk and are ignored, the way a re-scrape used to rotate the old cache aside.
 *
 * `sites.idx` is a snapshot of where each current row sits (JSON, rebuildable); open reads it and scans only the
 * bytes written after it. Several processes may append at once (single whole-line writes to an O_APPEND file).
 */
export class SitesRepo {
  private readonly lists = new Map<string, ListIdx>();
  private appendFd: number | null = null;
  private readFd: number | null = null;
  private scannedTo = 0;
  private snapshotAt = 0;

  constructor(private readonly files: SitesFiles, private readonly opts: { readOnly?: boolean } = {}) {
    this.loadSnapshot();
    this.refresh();
  }

  private loadSnapshot(): void {
    try {
      const s = JSON.parse(fs.readFileSync(this.files.index, 'utf8')) as { v: number; scannedTo: number; lists: { cat: string; list: string; g: number; sites: [string, number, number][] }[] };
      if (s.v !== 1 || !(s.scannedTo >= 0)) return;
      const size = fs.existsSync(this.files.data) ? fs.statSync(this.files.data).size : 0;
      if (s.scannedTo > size) return; // not this file's index
      for (const l of s.lists) this.lists.set(listKey(l.cat, l.list), { g: l.g, sites: new Map(l.sites.map(([site, offset, length]) => [site, { offset, length }])) });
      this.scannedTo = this.snapshotAt = s.scannedTo;
    } catch {
      this.lists.clear(); // no usable snapshot: scan from the start
    }
  }

  /** Indexes the records written since the last scan (by this or another process). */
  private refresh(): void {
    if (!fs.existsSync(this.files.data)) return;
    if (fs.statSync(this.files.data).size <= this.scannedTo) return;
    this.scannedTo = scanLines(this.files.data, this.scannedTo, (data, s, e, off) => {
      if (data[e - 1] !== 0x7d) return; // a complete record ends with `}`: this one was cut off
      const h = parseHead(data, s, e, BODY);
      if (!h || typeof h.cat !== 'string' || typeof h.list !== 'string' || typeof h.site !== 'string' || typeof h.g !== 'number') return;
      const key = listKey(h.cat, h.list);
      let l = this.lists.get(key);
      if (!l || h.g > l.g) this.lists.set(key, (l = { g: h.g, sites: new Map() }));
      if (h.g < l.g) return; // an earlier generation
      if (h.t === 'drop') l.sites.delete(h.site);
      else l.sites.set(h.site, { offset: off, length: e - s });
    });
  }

  private saveSnapshot(): void {
    const lists = [...this.lists].map(([key, l]) => {
      const [cat, list] = key.split('\0');
      return { cat, list, g: l.g, sites: [...l.sites].map(([site, x]) => [site, x.offset, x.length]) };
    });
    writeFileAtomic(this.files.index, JSON.stringify({ v: 1, scannedTo: this.scannedTo, lists }));
    this.snapshotAt = this.scannedTo;
  }

  /** The newest generation of a list; 0 if it has no rows. */
  generation(cat: string, list: string): number {
    this.refresh();
    return this.lists.get(listKey(cat, list))?.g ?? 0;
  }

  /** The list's results by site, from generation `g` (default: the newest). A generation with no rows yet is empty. */
  loadList(cat: string, list: string, g?: number): Map<string, SiteResult> {
    this.refresh();
    const out = new Map<string, SiteResult>();
    const l = this.lists.get(listKey(cat, list));
    if (!l || (g !== undefined && g !== l.g)) {
      if (l && g !== undefined && g < l.g) { // an earlier generation: read by scanning the file
        this.scanRows((row) => {
          if (row.cat !== cat || row.list !== list || row.g !== g) return;
          if (row.t === 'drop') out.delete(row.site);
          else if (row.r) out.set(row.site, row.r);
        });
      }
      return out;
    }
    this.readFd ??= fs.openSync(this.files.data, 'r');
    for (const [site, loc] of l.sites) {
      try {
        const row = JSON.parse(readAt(this.readFd, loc.offset, loc.length)!.toString('utf8')) as SiteRow;
        if (row.r) out.set(site, row.r);
      } catch (err) {
        log.warn({ err, site, cat, list }, `unreadable result for ${site} in ${cat}/${list}; it will be scraped again`);
      }
    }
    return out;
  }

  /** Calls `cb` for every record in the file, all lists and generations, in order. Reads the whole file: for reports, not for runs. */
  scanRows(cb: (row: SiteRow) => void): void {
    scanLines(this.files.data, 0, (data, s, e) => {
      try {
        cb(JSON.parse(data.toString('utf8', s, e)) as SiteRow);
      } catch { /* an unfinished or damaged record */ }
    });
  }

  /** The lists that have rows: newest generation and how many sites it holds. */
  listSummaries(): { cat: string; list: string; g: number; sites: number }[] {
    this.refresh();
    return [...this.lists].map(([key, l]) => {
      const [cat, list] = key.split('\0');
      return { cat, list, g: l.g, sites: l.sites.size };
    });
  }

  private writeLine(text: string): void {
    if (this.appendFd === null) {
      ensureTrailingNewline(this.files.data);
      this.appendFd = openAppend(this.files.data);
    }
    writeAll(this.appendFd, Buffer.from(text + '\n'));
  }

  /** Appends a finished site's result. Envelope fields come first, the result last, so an index never parses results. */
  append(who: ListRef, r: SiteResult, at = Date.now()): void {
    const head = JSON.stringify({ v: SITE_ROW_VERSION, t: 'site', cat: who.cat, list: who.list, g: who.g, run: who.run, a: at, site: r.site });
    this.writeLine(`${head.slice(0, -1)},"r":${JSON.stringify(r)}}`);
  }

  /** Removes a site's row from the list's current generation, so the site is scraped again. */
  drop(who: ListRef, site: string, at = Date.now()): void {
    this.writeLine(JSON.stringify({ v: SITE_ROW_VERSION, t: 'drop', cat: who.cat, list: who.list, g: who.g, run: who.run, a: at, site }));
  }

  close(): void {
    this.refresh();
    if (!this.opts.readOnly && (this.scannedTo - this.snapshotAt > SNAPSHOT_AFTER || (!fs.existsSync(this.files.index) && this.scannedTo > 0))) this.saveSnapshot();
    for (const fd of [this.readFd, this.appendFd]) if (fd !== null) fs.closeSync(fd);
    this.readFd = this.appendFd = null;
  }
}
