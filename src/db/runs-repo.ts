import fs from 'node:fs';
import { ensureTrailingNewline, openAppend, scanLines, writeAll } from './jsonl.js';

/** Record schema version written to run-history.jsonl. */
export const RUN_EVENT_VERSION = 1;

/**
 * Events, one per line of `results/db/run-history.jsonl` (append-only). Every event has `v`, `t` (the type), `a`
 * (epoch ms), `ts` (the same as ISO text) and `run` (the run's id; `legacy` for history imported from the old
 * per-category logs):
 *
 * - `run.start`  `{pid, argv, options, node}`            - a scrape or output command started
 * - `run.end`    `{durationMs, failedFiles}`
 * - `list.start` `{cat, list, g, mode, sites, resumed, fresh}` - a list began (or resumed) being processed
 * - `list.end`   `{cat, list, g, status, counts, reasons, csv, text}` - it finished; `text` is the summary block
 * - `filter.end` `{cat, list, text}`                     - a suffix-filtered CSV was written
 * - `unique.end` `{cat, label, text}`                    - a combined unique list was written
 *
 * A list is interrupted exactly when its latest `list.start` has no later `list.end` (a run that died, or hit an
 * error, never wrote it); the next plain run resumes it. This replaces the old `.inprogress` marker files.
 */
export interface RunEvent {
  t: string;
  run: string;
  [field: string]: unknown;
}

export interface ListStart {
  run: string;
  g: number;
  a: number;
  legacy?: boolean;
}

interface ListState {
  start?: ListStart;
  ended: boolean; // a list.end came after the latest list.start
  lastEnd?: number; // when the latest list.end was written
}

const listKey = (cat: string, list: string) => `${cat}\0${list}`;

export class RunsRepo {
  private readonly lists = new Map<string, ListState>();
  private fd: number | null = null;
  private scannedTo = 0;

  constructor(private readonly file: string) {
    this.refresh();
  }

  private apply(ev: RunEvent): void {
    if (ev.t !== 'list.start' && ev.t !== 'list.end') return;
    if (typeof ev.cat !== 'string' || typeof ev.list !== 'string') return;
    const key = listKey(ev.cat, ev.list);
    const s = this.lists.get(key) ?? { ended: true };
    if (ev.t === 'list.start') {
      s.start = { run: ev.run, g: Number(ev.g) || 1, a: Number(ev.a) || 0, ...(ev.legacy ? { legacy: true } : {}) };
      s.ended = false;
    } else {
      s.ended = true;
      s.lastEnd = Number(ev.a) || 0;
    }
    this.lists.set(key, s);
  }

  /** Takes in events written since the last look (by this or another process). */
  private refresh(): void {
    if (!fs.existsSync(this.file) || fs.statSync(this.file).size <= this.scannedTo) return;
    this.scannedTo = scanLines(this.file, this.scannedTo, (data, s, e) => {
      try {
        const ev = JSON.parse(data.toString('utf8', s, e)) as RunEvent;
        if (ev && typeof ev.t === 'string') this.apply(ev);
      } catch { /* an unfinished or damaged line */ }
    });
  }

  /** Writes one event. */
  append(ev: RunEvent & { a?: number }): void {
    if (this.fd === null) {
      ensureTrailingNewline(this.file);
      this.fd = openAppend(this.file);
    }
    const a = ev.a ?? Date.now();
    const full = { v: RUN_EVENT_VERSION, ...ev, a, ts: new Date(a).toISOString() };
    writeAll(this.fd, Buffer.from(JSON.stringify(full) + '\n'));
    this.apply(full as RunEvent);
  }

  /** The unfinished start of a list: its scrape was cut off and the next run resumes it. */
  interrupted(cat: string, list: string): ListStart | undefined {
    this.refresh();
    const s = this.lists.get(listKey(cat, list));
    return s && !s.ended ? s.start : undefined;
  }

  /** The generation of the list's latest start (0 if it never started). */
  startedGeneration(cat: string, list: string): number {
    this.refresh();
    return this.lists.get(listKey(cat, list))?.start?.g ?? 0;
  }

  /** Every list whose latest start is unfinished. */
  interruptedLists(): { cat: string; list: string; start: ListStart }[] {
    this.refresh();
    return [...this.lists].filter(([, s]) => !s.ended && s.start).map(([key, s]) => {
      const [cat, list] = key.split('\0');
      return { cat, list, start: s.start! };
    });
  }

  /** Calls `cb` for every event in the file, in order. */
  scan(cb: (ev: RunEvent) => void): void {
    scanLines(this.file, 0, (data, s, e) => {
      try {
        cb(JSON.parse(data.toString('utf8', s, e)) as RunEvent);
      } catch { /* an unfinished or damaged line */ }
    });
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
