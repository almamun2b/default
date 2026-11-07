import { hash as cryptoHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * A persistent hash table over an append-only data file: id -> where its newest record sits. It is derived data
 * (rebuilt from the file if missing or damaged), kept on disk so a store opens without reading the data file and a
 * lookup costs a couple of positional reads whatever its size.
 *
 * Layout: a 64-byte header, then 2^n slots of 32 bytes, linear probing, never deleted from (a newer record just
 * replaces its slot). Header: magic, version, slots, count, indexedBytes (how much of the data file the table
 * covers; the owner scans the data past it on open). Slot: hash lo, hash hi, offset (2 x u32), at (2 x u32),
 * length, flags. An all-zero hash marks an empty slot. Two ids with the same 64-bit hash are told apart by the
 * caller's `same` check, which reads the record.
 */

export interface IndexEntry {
  offset: number; // where the record's line starts in the data file
  length: number; // bytes of the line, without its newline
  at: number; // when the record was written (epoch ms); the newest wins
  gone: boolean; // the record says the thing no longer exists (a 404/410)
}

export interface Hash {
  lo: number;
  hi: number;
}

const MAGIC = 0x58494750; // "PGIX"
const VERSION = 1;
const HEADER = 64;
const SLOT = 32;
const BLOCK = 16; // slots read per positional read while probing
const MAX_LOAD = 0.6;
const GONE = 1;
const TWO32 = 2 ** 32;

export function hashOf(id: string): Hash {
  const d = cryptoHash('sha1', id, 'buffer');
  const lo = d.readUInt32LE(0), hi = d.readUInt32LE(4);
  return lo === 0 && hi === 0 ? { lo: 1, hi: 0 } : { lo, hi };
}

const put64 = (b: Buffer, at: number, n: number) => { b.writeUInt32LE(n % TWO32, at); b.writeUInt32LE(Math.floor(n / TWO32), at + 4); };
const get64 = (b: Buffer, at: number) => b.readUInt32LE(at) + b.readUInt32LE(at + 4) * TWO32;

function decode(b: Buffer, o: number): IndexEntry {
  return { offset: get64(b, o + 8), at: get64(b, o + 16), length: b.readUInt32LE(o + 24), gone: (b.readUInt32LE(o + 28) & GONE) !== 0 };
}

function encode(h: Hash, e: IndexEntry, b: Buffer, o: number): void {
  b.writeUInt32LE(h.lo, o);
  b.writeUInt32LE(h.hi, o + 4);
  put64(b, o + 8, e.offset);
  put64(b, o + 16, e.at);
  b.writeUInt32LE(e.length, o + 24);
  b.writeUInt32LE(e.gone ? GONE : 0, o + 28);
}

export class HashIndex {
  private fd: number;
  private slots: number;
  /** Number of ids in the table. */
  count: number;
  /** How much of the data file the table covers. */
  indexedBytes: number;
  private unflushed = 0;
  /** True when the table was created empty (no file, or one that could not be trusted): the data must be scanned in full. */
  readonly fresh: boolean;

  private constructor(private readonly file: string, fd: number, slots: number, count: number, indexedBytes: number, fresh: boolean) {
    this.fd = fd;
    this.slots = slots;
    this.count = count;
    this.indexedBytes = indexedBytes;
    this.fresh = fresh;
  }

  /** Opens the table at `file`, or creates an empty one with room for about `expected` ids when it is missing or unusable. */
  static open(file: string, expected = 1 << 15): HashIndex {
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, 'r+');
      const head = Buffer.alloc(HEADER);
      const ok = fs.readSync(fd, head, 0, HEADER, 0) === HEADER
        && head.readUInt32LE(0) === MAGIC && head.readUInt32LE(4) === VERSION;
      const slots = ok ? get64(head, 8) : 0;
      if (ok && slots >= 2 && (slots & (slots - 1)) === 0 && fs.fstatSync(fd).size === HEADER + slots * SLOT) {
        return new HashIndex(file, fd, slots, get64(head, 16), get64(head, 24), false);
      }
      fs.closeSync(fd);
    }
    return HashIndex.create(file, slotsFor(expected), true);
  }

  private static create(file: string, slots: number, fresh: boolean): HashIndex {
    const fd = fs.openSync(file, 'w+', 0o600);
    fs.ftruncateSync(fd, HEADER + slots * SLOT);
    const ix = new HashIndex(file, fd, slots, 0, 0, fresh);
    ix.writeHeader();
    return ix;
  }

  private writeHeader(): void {
    const head = Buffer.alloc(HEADER);
    head.writeUInt32LE(MAGIC, 0);
    head.writeUInt32LE(VERSION, 4);
    put64(head, 8, this.slots);
    put64(head, 16, this.count);
    put64(head, 24, this.indexedBytes);
    fs.writeSync(this.fd, head, 0, HEADER, 0);
    this.unflushed = 0;
  }

  /** Records how far into the data file the table now reaches and saves the header. */
  flush(indexedBytes = this.indexedBytes): void {
    this.indexedBytes = indexedBytes;
    this.writeHeader();
  }

  close(): void {
    if (this.fd < 0) return;
    this.writeHeader();
    fs.closeSync(this.fd);
    this.fd = -1;
  }

  /** The slot holding the id (`found`), or the empty slot where it would go. */
  private locate(h: Hash, same: (e: IndexEntry) => boolean): { slot: number; entry?: IndexEntry } {
    const slots = this.slots;
    let i = h.lo & (slots - 1);
    for (let probed = 0; probed < slots;) {
      const n = Math.min(BLOCK, slots - i);
      const buf = Buffer.alloc(n * SLOT);
      fs.readSync(this.fd, buf, 0, buf.length, HEADER + i * SLOT);
      for (let j = 0; j < n; j++, probed++) {
        const o = j * SLOT;
        const lo = buf.readUInt32LE(o), hi = buf.readUInt32LE(o + 4);
        if (lo === 0 && hi === 0) return { slot: i + j };
        if (lo === h.lo && hi === h.hi) {
          const entry = decode(buf, o);
          if (same(entry)) return { slot: i + j, entry };
        }
      }
      i = (i + n) % slots;
    }
    throw new Error(`${this.file} is full`);
  }

  /** The newest entry for the id. `same` confirms a candidate really is that id (the caller reads the record). */
  get(h: Hash, same: (e: IndexEntry) => boolean): IndexEntry | undefined {
    return this.locate(h, same).entry;
  }

  /**
   * Stores the entry unless the table already has one for the id that is newer; a tie goes to the later write.
   * Returns what happened, so an importer can count what it skipped.
   */
  set(h: Hash, entry: IndexEntry, same: (e: IndexEntry) => boolean): 'added' | 'updated' | 'kept' {
    let at = this.locate(h, same);
    if (at.entry) {
      if (at.entry.at > entry.at) return 'kept';
    } else if ((this.count + 1) / this.slots > MAX_LOAD) {
      this.grow();
      at = this.locate(h, same);
    }
    const buf = Buffer.alloc(SLOT);
    encode(h, entry, buf, 0);
    fs.writeSync(this.fd, buf, 0, SLOT, HEADER + at.slot * SLOT);
    if (!at.entry) this.count++;
    if (++this.unflushed >= 4096) this.writeHeader();
    return at.entry ? 'updated' : 'added';
  }

  /** Doubles the table: rehashes every slot into a new file that then replaces this one. */
  private grow(): void {
    const tmp = this.file + '.tmp';
    const next = HashIndex.create(tmp, this.slots * 2, false);
    const chunk = 1 << 15; // slots per read
    const buf = Buffer.alloc(chunk * SLOT);
    for (let s = 0; s < this.slots; s += chunk) {
      const n = Math.min(chunk, this.slots - s);
      fs.readSync(this.fd, buf, 0, n * SLOT, HEADER + s * SLOT);
      for (let j = 0; j < n; j++) {
        const o = j * SLOT;
        const lo = buf.readUInt32LE(o), hi = buf.readUInt32LE(o + 4);
        if (lo === 0 && hi === 0) continue;
        next.place({ lo, hi }, buf, o);
      }
    }
    next.count = this.count;
    next.indexedBytes = this.indexedBytes;
    next.writeHeader();
    fs.closeSync(this.fd);
    fs.closeSync(next.fd);
    fs.renameSync(tmp, this.file);
    this.fd = fs.openSync(this.file, 'r+');
    this.slots = next.slots;
  }

  /** Puts a copied slot into its first free place; the ids are distinct, so no comparing. */
  private place(h: Hash, src: Buffer, at: number): void {
    const free = this.locate(h, () => false).slot;
    fs.writeSync(this.fd, src, at, SLOT, HEADER + free * SLOT);
  }
}

/** A power-of-two slot count that holds `ids` ids below the load limit. */
function slotsFor(ids: number): number {
  let s = 1 << 12;
  while (ids / s > MAX_LOAD / 1.5) s *= 2;
  return s;
}
