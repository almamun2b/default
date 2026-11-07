import fs from 'node:fs';

/**
 * Low-level helpers for the JSON-lines files in results/db/. A record is one line; a record cut off by
 * a crash is a line that fails to parse and is skipped, and the next writer starts on a fresh line
 * (ensureTrailingNewline), so a bad record never swallows a good one.
 */

const SCAN_CHUNK = 8 << 20;

/** Makes sure the next append starts on a fresh line, even if an interrupted run left the last record unfinished. */
export function ensureTrailingNewline(file: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
  } finally {
    fs.closeSync(fd);
  }
  fs.appendFileSync(file, '\n');
}

/** Opens `file` for appending (created readable by its owner only: the files hold personal data). */
export function openAppend(file: string): number {
  const fd = fs.openSync(file, 'a', 0o600);
  if (fs.fstatSync(fd).mode & 0o077) fs.fchmodSync(fd, 0o600); // a file someone created empty with a wider mode
  return fd;
}

/** Writes all of `data`; a write to a regular file is normally whole, but a short write must not drop the rest. */
export function writeAll(fd: number, data: Buffer): void {
  let done = 0;
  while (done < data.length) done += fs.writeSync(fd, data, done, data.length - done);
}

/**
 * Calls `onLine(data, start, end, offset)` for every complete line (newline-terminated) of `file` from byte `from`.
 * `data[start..end)` is the line without its newline and `offset` its position in the file. Returns the offset just
 * past the last complete line, i.e. where the next scan should resume; an unterminated tail is left for later.
 */
export function scanLines(file: string, from: number, onLine: (data: Buffer, start: number, end: number, offset: number) => void): number {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return from;
  }
  try {
    const buf = Buffer.alloc(SCAN_CHUNK);
    let carry: Buffer = Buffer.alloc(0);
    let base = from; // file offset of carry[0]
    for (;;) {
      const n = fs.readSync(fd, buf, 0, SCAN_CHUNK, base + carry.length);
      if (n === 0) break;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      for (let nl = data.indexOf(10, start); nl >= 0; nl = data.indexOf(10, start)) {
        onLine(data, start, nl, base + start);
        start = nl + 1;
      }
      base += start;
      carry = data.subarray(start);
    }
    return base;
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads `length` bytes at `offset`; undefined if the file ends sooner. */
export function readAt(fd: number, offset: number, length: number): Buffer | undefined {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, offset + got);
    if (n === 0) return undefined;
    got += n;
  }
  return buf;
}

/**
 * Parses the identifying head of a record. Every record is `{...identifiers, "<bodyKey>":{...body}}` with the
 * (possibly large) body last, so an index can be built without parsing it: the head is the text before the
 * body key, closed with `}`. `bodyMarkers` are the body keys a record may use (`,"page":` and its older
 * spelling `,"d":`); the earliest one found ends the head, as the head itself never contains one. Records without a
 * body (tombstones, "gone" markers) are parsed whole.
 */
export function parseHead(data: Buffer, start: number, end: number, bodyMarkers: Buffer[]): Record<string, unknown> | null {
  try {
    const line = data.subarray(start, end);
    let cut = -1;
    for (const m of bodyMarkers) {
      const i = line.indexOf(m);
      if (i >= 0 && (cut < 0 || i < cut)) cut = i;
    }
    if (cut >= 0) return JSON.parse(data.toString('utf8', start, start + cut) + '}') as Record<string, unknown>;
    return JSON.parse(data.toString('utf8', start, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Splits JSON-lines text on its newlines, skipping blanks. */
export function* lines(text: string): Generator<string> {
  for (const l of text.split('\n')) if (l.trim()) yield l;
}
