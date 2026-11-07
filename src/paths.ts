import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const IN_DIR = path.join(ROOT, 'websites');
/** results/ by default; SCRAPER_RESULTS_DIR points a run at another folder (a scratch copy for a test run, say). */
export const OUT_DIR = process.env.SCRAPER_RESULTS_DIR ? path.resolve(process.env.SCRAPER_RESULTS_DIR) : path.join(ROOT, 'results');

/** Where the database lives: results/db/ (see src/db/). */
export const DB_NAME = 'db';
/** Where every output CSV lives: results/emails/<category>/. */
export const EMAILS_NAME = 'emails';

export interface DbFiles {
  dir: string;
  pages: string; // every page ever visited (JSON lines; newest record wins)
  pagesIndex: string; // its persistent hash index (derived)
  sites: string; // every list's per-site results (JSON lines)
  sitesIndex: string; // its index snapshot (derived)
  runs: string; // run and list history: starts, ends, summaries
  manifest: string; // schema version and the ledger of imports
  locksDir: string;
}

export function dbFiles(outDir = OUT_DIR): DbFiles {
  const dir = path.join(outDir, DB_NAME);
  return {
    dir,
    pages: path.join(dir, 'pages.jsonl'),
    pagesIndex: path.join(dir, 'pages.idx'),
    sites: path.join(dir, 'sites.jsonl'),
    sitesIndex: path.join(dir, 'sites.idx'),
    runs: path.join(dir, 'run-history.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
    locksDir: path.join(dir, 'locks'),
  };
}

/** Folders directly under results/ that are not categories: the database, the output tree, the cross-category unique lists' folder name. */
const RESERVED = new Set([DB_NAME, EMAILS_NAME, 'unique']);

/** Everything one input file writes. `id` (`dealers/au.ford`) names it in messages. */
export interface FileLayout {
  id: string;
  group: string; // the category (or, for an uncategorized list, its own name)
  base: string;
  emailsDir: string; // results/emails/<group>
  outFile: string;
  filteredDir: string; // the --include-suffix / --exclude-suffix CSVs of this category's lists
  uniqueDir: string;
}

const baseName = (f: string) => path.basename(f, path.extname(f));

/** The single folder name of `file` directly inside `dir`, or undefined if it isn't exactly one level down. */
function folderIn(dir: string, file: string): string | undefined {
  const rel = path.relative(dir, path.dirname(path.resolve(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return undefined;
  return rel;
}

/** The category of an input or output CSV: its folder under websites/ (websites/<category>/x.csv) or results/emails/ (results/emails/<category>/x.csv), else undefined. */
export function categoryOf(file: string, inDir = IN_DIR, outDir = OUT_DIR): string | undefined {
  return folderIn(inDir, file) ?? folderIn(path.join(outDir, EMAILS_NAME), file);
}

/** The results/emails/<group>/ folder for a CSV: its category, else its own base name, so an uncategorized list gets a folder to itself. */
export function groupOf(file: string, inDir = IN_DIR, outDir = OUT_DIR): string {
  return categoryOf(file, inDir, outDir) ?? baseName(file);
}

export function fileLayout(group: string, base: string, outDir = OUT_DIR): FileLayout {
  if (RESERVED.has(group)) throw new Error(`"${group}" can't be a category: results/${group}/ is reserved (the database, the output tree, the cross-category lists). Rename the folder under websites/.`);
  const emailsDir = path.join(outDir, EMAILS_NAME, group);
  return {
    id: `${group}/${base}`,
    group,
    base,
    emailsDir,
    outFile: path.join(emailsDir, `${base}.csv`),
    filteredDir: path.join(emailsDir, 'filtered'),
    uniqueDir: path.join(emailsDir, 'unique'),
  };
}

/** The folder of the combined lists that span categories (--unique with files of several categories). */
export const crossUniqueDir = (outDir = OUT_DIR) => path.join(outDir, EMAILS_NAME, 'unique');

const isCsv = (e: fs.Dirent) => e.isFile() && e.name.toLowerCase().endsWith('.csv');

/** Input lists: websites/*.csv (uncategorized) and websites/<category>/*.csv, sorted. */
export function findInputs(inDir = IN_DIR): string[] {
  if (!fs.existsSync(inDir)) return [];
  const files: string[] = [];
  for (const e of fs.readdirSync(inDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (isCsv(e)) files.push(path.join(inDir, e.name));
    else if (e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(inDir, e.name), { withFileTypes: true })) {
        if (!f.name.startsWith('.') && isCsv(f)) files.push(path.join(inDir, e.name, f.name));
      }
    }
  }
  return files.sort();
}

/** Output CSVs per group folder (results/emails/<group>/*.csv, not its unique/ or filtered/ subfolders); the cross-category emails/unique/ is not a group. */
export function findOutputs(outDir = OUT_DIR): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const root = path.join(outDir, EMAILS_NAME);
  if (!fs.existsSync(root)) return groups;
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'unique') continue;
    const dir = path.join(root, e.name);
    const csvs = fs.readdirSync(dir, { withFileTypes: true }).filter(isCsv).map((f) => path.join(dir, f.name)).sort();
    if (csvs.length) groups.set(e.name, csvs);
  }
  return groups;
}
