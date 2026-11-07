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
  generation: number; // a fresh re-scrape of a list opens the next one
  run: string;
}

/** A record of sites.jsonl. */
export interface SiteRow extends ListRef {
  version: number;
  type: 'site' | 'drop';
  writtenAt: number; // epoch ms
  site: string;
  result?: SiteResult; // absent on a `drop`
}

/** Record schema version written to sites.jsonl. Version 1 used `v, t, g, a, r` for `version, type, generation, writtenAt, result`. */
export const SITE_ROW_VERSION = 2;

const BODY = Buffer.from(',"result":');
const LEGACY_BODY = Buffer.from(',"r":');
const BODIES = [BODY, LEGACY_BODY];

/** A row's fields under their current names, whichever version wrote it (`h` may be a row without its body). */
export function siteRowFields(h: Record<string, unknown>): Record<string, unknown> {
  if (h.version !== undefined || h.v === undefined) return h;
  const { v, t, g, a, r, ...rest } = h;
  return { version: v, type: t, ...rest, generation: g, writtenAt: a, ...(r !== undefined ? { result: r } : {}) };
}
const SNAPSHOT_AFTER = 4 << 20; // bytes read past the saved index before it is saved again

type Loc = { offset: number; length: number };
type ListIdx = { generation: number; sites: Map<string, Loc> };
const listKey = (cat: string, list: string) => `${cat}\0${list}`;

/**
 * The result of every site of every list, in `results/db/sites.jsonl`, one record per line:
 * `{"version":2,"type":"site","cat":..,"list":..,"generation":..,"run":..,"writtenAt":..,"site":..,"result":<SiteResult>}`. Within the newest
 * generation of a list the last record of a site wins, and a `drop` record (`"type":"drop"`) removes it again (a
 * retry that crawls a failed site afresh drops the old row so an interrupted retry still redoes it). Earlier
 * generations stay on disk and are ignored, the way a re-scrape used to rotate the old cache aside. Version 1
 * rows (`v, t, g, a, r`) are read as well; `npm run db:upgrade` rewrites them.
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
      const s = JSON.parse(fs.readFileSync(this.files.index, 'utf8')) as { version: number; scannedTo: number; lists: { cat: string; list: string; generation: number; sites: [string, number, number][] }[] };
      if (s.version !== 2 || !(s.scannedTo >= 0)) return; // an older snapshot is rebuilt by scanning
      const size = fs.existsSync(this.files.data) ? fs.statSync(this.files.data).size : 0;
      if (s.scannedTo > size) return; // not this file's index
      for (const l of s.lists) this.lists.set(listKey(l.cat, l.list), { generation: l.generation, sites: new Map(l.sites.map(([site, offset, length]) => [site, { offset, length }])) });
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
      const raw = parseHead(data, s, e, BODIES);
      const h = raw && siteRowFields(raw);
      if (!h || typeof h.cat !== 'string' || typeof h.list !== 'string' || typeof h.site !== 'string' || typeof h.generation !== 'number') return;
      const key = listKey(h.cat, h.list);
      let l = this.lists.get(key);
      if (!l || h.generation > l.generation) this.lists.set(key, (l = { generation: h.generation, sites: new Map() }));
      if (h.generation < l.generation) return; // an earlier generation
      if (h.type === 'drop') l.sites.delete(h.site);
      else l.sites.set(h.site, { offset: off, length: e - s });
    });
  }

  private saveSnapshot(): void {
    const lists = [...this.lists].map(([key, l]) => {
      const [cat, list] = key.split('\0');
      return { cat, list, generation: l.generation, sites: [...l.sites].map(([site, x]) => [site, x.offset, x.length]) };
    });
    writeFileAtomic(this.files.index, JSON.stringify({ version: 2, scannedTo: this.scannedTo, lists }));
    this.snapshotAt = this.scannedTo;
  }

  /** The newest generation of a list; 0 if it has no rows. */
  generation(cat: string, list: string): number {
    this.refresh();
    return this.lists.get(listKey(cat, list))?.generation ?? 0;
  }

  /** The list's results by site, from `generation` (default: the newest). A generation with no rows yet is empty. */
  loadList(cat: string, list: string, generation?: number): Map<string, SiteResult> {
    this.refresh();
    const out = new Map<string, SiteResult>();
    const l = this.lists.get(listKey(cat, list));
    if (!l || (generation !== undefined && generation !== l.generation)) {
      if (l && generation !== undefined && generation < l.generation) { // an earlier generation: read by scanning the file
        this.scanRows((row) => {
          if (row.cat !== cat || row.list !== list || row.generation !== generation) return;
          if (row.type === 'drop') out.delete(row.site);
          else if (row.result) out.set(row.site, row.result);
        });
      }
      return out;
    }
    this.readFd ??= fs.openSync(this.files.data, 'r');
    for (const [site, loc] of l.sites) {
      try {
        const row = siteRowFields(JSON.parse(readAt(this.readFd, loc.offset, loc.length)!.toString('utf8'))) as unknown as SiteRow;
        if (row.result) out.set(site, row.result);
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
        cb(siteRowFields(JSON.parse(data.toString('utf8', s, e))) as unknown as SiteRow);
      } catch { /* an unfinished or damaged record */ }
    });
  }

  /** The lists that have rows: newest generation and how many sites it holds. */
  listSummaries(): { cat: string; list: string; generation: number; sites: number }[] {
    this.refresh();
    return [...this.lists].map(([key, l]) => {
      const [cat, list] = key.split('\0');
      return { cat, list, generation: l.generation, sites: l.sites.size };
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
    const head = JSON.stringify({ version: SITE_ROW_VERSION, type: 'site', cat: who.cat, list: who.list, generation: who.generation, run: who.run, writtenAt: at, site: r.site });
    this.writeLine(`${head.slice(0, -1)},"result":${JSON.stringify(r)}}`);
  }

  /** Removes a site's row from the list's current generation, so the site is scraped again. */
  drop(who: ListRef, site: string, at = Date.now()): void {
    this.writeLine(JSON.stringify({ version: SITE_ROW_VERSION, type: 'drop', cat: who.cat, list: who.list, generation: who.generation, run: who.run, writtenAt: at, site }));
  }

  close(): void {
    this.refresh();
    if (!this.opts.readOnly && (this.scannedTo - this.snapshotAt > SNAPSHOT_AFTER || (!fs.existsSync(this.files.index) && this.scannedTo > 0))) this.saveSnapshot();
    for (const fd of [this.readFd, this.appendFd]) if (fd !== null) fs.closeSync(fd);
    this.readFd = this.appendFd = null;
  }
}
