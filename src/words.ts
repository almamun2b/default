import fs from 'node:fs';

/** One lowercase entry per line in src/data/<file>. */
export function loadList(file: string): Set<string> {
  return new Set(readLines(file).map((l) => l.toLowerCase()));
}

export function readLines(file: string): string[] {
  return fs.readFileSync(new URL(`./data/${file}`, import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

// Words of three letters or fewer are only used when listed here: unlisted ones would cut almost any label up.
const SHORT = new Map<string, number>(
  ['the', 'and', 'for', 'bay', 'car', 'cars', 'spa', 'art', 'gym', 'pub', 'inn', 'zoo', 'kid', 'fit', 'run', 'sun', 'sea', 'top', 'one', 'new', 'red', 'old',
    'big', 'oak', 'hub', 'pro', 'tip', 'cafe', 'bar', 'day', 'dog', 'pet', 'toy', 'fun', 'hot', 'ice', 'sky', 'web', 'net', 'tech', 'eco', 'bike', 'tyre',
    'nz', 'au', 'uk', 'us', 'usa', 'nsw', 'qld', 'vic', 'tas', 'wa', 'sa', 'nt', 'act', 'mt', 'st', 'of'].map((w) => [w, 3]),
);

/** Letters that stay capitals when a domain or mailbox is turned into a name ("nz" → "NZ"). */
const ACRONYMS = new Set(['nz', 'au', 'uk', 'us', 'usa', 'nsw', 'qld', 'vic', 'tas', 'wa', 'sa', 'nt', 'act', 'bmw', 'gm', 'mg', 'byd', 'kia', 'ymca', 'pcyc', 'oshc', 'hr', 'it', 'ict']);

let vocab: Map<string, number> | null = null;
const words = (): Map<string, number> => {
  if (!vocab) {
    vocab = new Map(SHORT);
    for (const l of readLines('name-words.txt')) {
      const [w, n] = l.split(' ');
      vocab.set(w, Math.max(vocab.get(w) ?? 0, Number(n) || 1));
    }
  }
  return vocab;
};

const cap = (w: string) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
export const titleWords = (ws: string[]): string => ws.filter(Boolean).map(cap).join(' ');

/**
 * Cuts a run of letters into known words ("anytimefitness" → anytime, fitness): the cheapest cut, where a word costs
 * less the more often it is seen in business names and a split costs extra. Null when the run is not made of known
 * words (or would need more than four).
 */
export function splitWords(run: string): string[] | null {
  const v = words();
  const n = run.length;
  if (n < 2 || n > 40) return null;
  const best: ({ cost: number; at: number; count: number } | null)[] = Array(n + 1).fill(null);
  best[0] = { cost: 0, at: 0, count: 0 };
  for (let end = 1; end <= n; end++) {
    for (let start = Math.max(0, end - 20); start < end; start++) {
      const prev = best[start];
      if (!prev || prev.count >= 4) continue;
      const w = run.slice(start, end);
      const weight = v.get(w);
      if (!weight || (w.length <= 3 && !SHORT.has(w))) continue;
      const cost = prev.cost + 6 - Math.min(Math.log(weight + 1), 5); // each word has a price; common words are cheaper
      if (!best[end] || cost < best[end]!.cost) best[end] = { cost, at: start, count: prev.count + 1 };
    }
  }
  if (!best[n]) return null;
  const out: string[] = [];
  for (let i = n; i > 0; i = best[i]!.at) out.unshift(run.slice(best[i]!.at, i));
  return out;
}

/** A run of letters as words for a name: split when it is known words, else one word ("Kryalcastle"), or capitals when it has no vowel, two letters, or four letters with one vowel ("CLMNZ", "YMCA"). */
function runName(run: string): string {
  const parts = splitWords(run);
  if (parts) return titleWords(parts);
  const vowels = (run.match(/[aeiou]/g) ?? []).length;
  return vowels === 0 || run.length === 2 || (run.length === 4 && vowels <= 1) ? run.toUpperCase() : cap(run); // PCYC, CLMNZ, YMCA; "bega", "obrien" stay words
}

/** "customerservice" → "Customer Service", "autohaus-pickel" → "Autohaus Pickel", "clmnz" → "CLMNZ". */
export function nameFromLabel(label: string): string {
  return label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    // one or two digits stay on the letters before them ("q1", "t4 Arb"); a longer number is its own word
    .flatMap((part) => (part.match(/[a-z]+(?:\d{1,2}(?!\d))?|\d+/g) ?? []).flatMap((p) => {
      const m = /^([a-z]+)(\d{1,2})$/.exec(p);
      return /^\d+$/.test(p) ? [p] : m ? [runName(m[1]) + m[2]] : [runName(p)];
    }))
    .join(' ');
}

/** The name a registrable domain stands for when no site of it was scraped: its first label as words ("anytimefitness.in" → "Anytime Fitness"). */
export const nameFromDomain = (domain: string): string => nameFromLabel(domain.split('.')[0]);

/** Whether `word` is a known word of the vocabulary (a business-name word, name, place or dictionary word). */
export const isKnownWord = (word: string): boolean => words().has(word);
