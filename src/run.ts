import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';
import { budgetRetry, planRetries, type RetryFlags } from './cache.js';
import { CACHE_VERSION, mergeResults, resumeSite, scrapeSite, type CrawlOptions, type ResumeParts, type SiteResult } from './crawler.js';
import type { Db } from './db/open.js';
import { lockPid, pidAlive, writeFileAtomic } from './db/lock.js';
import type { ListRef } from './db/sites-repo.js';
import { filterRows, filterSummary, filterTag, type SuffixFilter } from './filter.js';
import { readSites } from './input.js';
import { undeliverable } from './mx.js';
import { log, runId, withLogContext } from './logger.js';
import { assignRows, recheckSite, uniqueLabel, uniqueRows, type Assigned, type Row } from './output.js';
import { crossUniqueDir, fileLayout, findOutputs, groupOf, OUT_DIR, ROOT, type FileLayout } from './paths.js';
import { baseHost } from './urls.js';

const HARD_TIMEOUT_EXTRA_MS = 4 * 60_000; // hard safety net on top of scrapeSite's soft budget, which keeps partial results
const STOP_GRACE_MS = 30_000;

export interface RunOptions extends CrawlOptions {
  concurrency: number; // sites in parallel
  hostConcurrency: number; // parallel requests to one server across all sites
  checkMx?: boolean; // drop emails whose domain can't receive mail (--check-mx)
  revalidateDays: number; // stored pages older than this are requested again (--revalidate); 0 = every one, once per run
  filter?: SuffixFilter; // --include-suffix / --exclude-suffix: also write a filtered CSV; scraping and the normal CSV are unaffected
}

/**
 * Scrapes one site under a hard time limit, or continues it from `from` (resumeSite). At the limit the scrape
 * is aborted and has STOP_GRACE_MS to return what it found. A scrape that won't stop falls back to what it had
 * before its browser phase, else to an empty result (or the earlier one when resuming); so does a crash.
 * Never rejects, so one broken site never stops the run.
 */
export function runSite(site: string, opts: RunOptions, from?: { prev: SiteResult; parts: ResumeParts }): Promise<SiteResult> {
  const limitMs = opts.budgetMs + HARD_TIMEOUT_EXTRA_MS;
  const empty = (error: string): SiteResult => from?.prev ?? {
    v: CACHE_VERSION, site, finalUrl: site, business: baseHost(new URL(site).hostname), emails: [], pages: 0, usedBrowser: false, error,
  };
  let partial: SiteResult | undefined;
  const onPartial = (r: SiteResult) => { partial = r; };
  return new Promise((resolve) => {
    const ctl = new AbortController();
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (r: SiteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(grace);
      resolve(r);
    };
    const hard = setTimeout(() => {
      log.warn({ timeoutMs: limitMs }, `stopped after the ${Math.round(limitMs / 60_000)}-minute hard limit; keeping what it found`);
      ctl.abort();
      grace = setTimeout(() => {
        const kept = partial ? 'keeping what it found before its browser phase' : from ? 'this pass is lost and the earlier result kept' : 'its partial results are lost';
        log.warn({ graceMs: STOP_GRACE_MS }, `did not stop within ${STOP_GRACE_MS / 1000} s after the hard limit; ${kept}`);
        finish(partial ? { ...partial, error: partial.error ?? 'timeout' } : empty('timeout'));
      }, STOP_GRACE_MS);
    }, limitMs);
    const run = from ? resumeSite(from.prev, from.parts, opts, ctl.signal, onPartial) : scrapeSite(site, opts, ctl.signal, onPartial);
    run.then(finish, (err) => {
      log.error({ err }, `scraper bug while crawling this site (${from ? 'earlier result kept' : 'recorded as internal-error'}); stack trace in logs/error-<date>.log`);
      finish(empty('internal-error'));
    });
  });
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

const REASON_CODES = new Set(['unreachable', 'robots-disallowed', 'robots-unavailable', 'timeout', 'browser-error', 'internal-error']);

/** Failure reason for the summary's counts: older cache lines can hold raw exception text. */
function reasonCode(error: string): string {
  return REASON_CODES.has(error) ? error : 'other';
}

/** Human-readable summary of one processed CSV; printed and recorded in the list's list.end event in results/db/run-history.jsonl. */
export function describe(o: RunOptions): string {
  return `${o.maxPages || 'unlimited'} pages, ${o.browserPages} browser pages, depth ${o.maxDepth || 'unlimited'}, ${o.budgetMs / 60_000} min/site, ${o.concurrency} sites in parallel, ${o.pageConcurrency} page requests per site, ${o.hostConcurrency} per server, stored pages revalidated after ${o.revalidateDays} days${o.checkMx ? ', MX check' : ''}`;
}

const COLUMNS = ['name', 'email', 'website', 'link'];

/** Writes a CSV atomically; folders under results/ are created readable by their owner only (personal data). */
function writeCsv(file: string, rows: Row[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, stringify(rows, { header: true, columns: COLUMNS }));
}

/** The cached results with the current rules applied (and, with --check-mx, undeliverable domains dropped). */
async function checkedResults(done: Map<string, SiteResult>, checkMx: boolean): Promise<{ checked: Map<string, SiteResult>; mxDropped?: string[] }> {
  const checked = new Map([...done].map(([site, r]) => [site, recheckSite(r)]));
  if (!checkMx) return { checked };
  const bad = await undeliverable([...checked.values()].flatMap((r) => r.emails.map((e) => e.email)));
  for (const [s, r] of checked) if (r.emails.some((e) => bad.has(e.email))) checked.set(s, { ...r, emails: r.emails.filter((e) => !bad.has(e.email)) });
  return { checked, mxDropped: [...bad].sort() };
}

export const filteredPath = (layout: FileLayout, filter: SuffixFilter) => path.join(layout.filteredDir, `${layout.base}.${filterTag(filter)}.csv`);

/** results/emails/<category>/filtered/<name>.<filter>.csv from a list's rows, with its summary recorded in the run history. */
function writeFiltered(db: Db, layout: FileLayout, rows: Row[], filter: SuffixFilter): void {
  const { kept, dropped } = filterRows(rows, filter);
  const out = filteredPath(layout, filter);
  writeCsv(out, kept);
  const text = filterSummary(`${layout.id}.csv`, filter, rows.length, kept.length, dropped, path.relative(ROOT, out));
  db.runs.append({ t: 'filter.end', run: runId, cat: layout.group, list: layout.base, csv: path.relative(ROOT, out), emails: rows.length, kept: kept.length, text });
  log.info({ output: path.relative(ROOT, out), emails: rows.length, kept: kept.length }, '\n' + text);
}

/**
 * The filtered CSV of a list that is not scraped (it already has an output): rebuilt from its stored results with
 * the current rules and written next to the others. The normal CSV and the database are left alone, nothing is requested.
 */
export async function filterFile(db: Db, file: string, layout: FileLayout, opts: RunOptions): Promise<void> {
  if (!opts.filter) return;
  const { group: cat, base: list } = layout;
  const rel = path.relative(ROOT, file);
  if (db.runs.interrupted(cat, list)) {
    log.warn({ input: rel }, `Skipping the filter for ${layout.id}: its last scrape was interrupted. Resume it first (re-run the scrape)`);
    return;
  }
  const release = db.lockList(cat, list);
  try {
    const stored = db.sites.loadList(cat, list);
    if (!stored.size) {
      log.warn({ input: rel }, `Skipping the filter for ${layout.id}: no stored results to filter`);
      return;
    }
    const input = readSites(file);
    if (!input.sites.length) return;
    const { checked } = await checkedResults(stored, !!opts.checkMx);
    writeFiltered(db, layout, assignRows(input.sites, checked, input.names).rows, opts.filter);
  } finally {
    release();
  }
}

/** What a finished list adds up to; stored in the `list.end` event next to the summary text. */
interface Summary {
  text: string;
  counts: Record<string, number>;
  reasons: Record<string, number>;
}

function summarize(layout: FileLayout, sites: string[], done: Map<string, SiteResult>, out: Assigned, mode: string, startedAt: number, mxDropped?: string[]): Summary {
  const uniqueEmails = out.rows.length;
  const results = sites.map((s) => done.get(s)).filter((r): r is SiteResult => !!r);
  const withEmails = results.filter((r) => r.emails.length > 0);
  const noEmails = results.filter((r) => !r.emails.length && !r.error);
  const failed = results.filter((r) => !r.emails.length && r.error);
  const reasons = new Map<string, number>();
  const details = new Map<string, Map<string, number>>(); // reason → errorDetail → sites
  for (const r of failed) {
    const reason = reasonCode(r.error!);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (!r.errorDetail) continue;
    const d = details.get(reason) ?? new Map<string, number>();
    d.set(r.errorDetail, (d.get(r.errorDetail) ?? 0) + 1);
    details.set(reason, d);
  }
  const breakdown = (reason: string) => {
    const d = details.get(reason);
    return d ? ` (${[...d].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  };
  const partial = results.filter((r) => r.emails.length && r.error);
  const k = out.kinds;
  const host = (r: SiteResult) => baseHost(new URL(r.site).hostname);
  const top = [...withEmails].sort((a, b) => b.emails.length - a.emails.length).slice(0, 5);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const missing = sites.length - results.length;
  const reused = results.reduce((n, r) => n + (r.reused ?? 0), 0);
  const fetched = results.reduce((n, r) => n + r.pages, 0) - reused;
  const lines = [
    `[${stamp}] ${layout.id}.csv  (${mode}, took ${fmtDuration(Date.now() - startedAt)})`,
    `  Websites : ${sites.length} total | ${withEmails.length} with emails | ${noEmails.length} no emails found | ${failed.length} failed`,
    `  Emails   : ${uniqueEmails} unique (${k.person} person name, ${k.department} department page title, ${k.input} input name, ${k.business} business name)`,
    `  Crawl    : ${fetched} pages fetched${reused ? ` + ${reused} reused (already scraped, not requested again)` : ''} | headless browser used on ${results.filter((r) => r.usedBrowser).length} sites`,
  ];
  if (mxDropped) {
    const list = mxDropped.slice(0, 5).join(', ') + (mxDropped.length > 5 ? ', …' : '');
    lines.push(`  MX check : ${mxDropped.length ? `${mxDropped.length} email(s) dropped, their domain can't receive mail: ${list}` : "every email's domain can receive mail"}`);
  }
  if (missing) lines.push(`  Missing  : ${missing} site(s) not scraped yet (no stored result)`);
  if (reasons.size) lines.push(`  Failures : ${[...reasons].map(([k, v]) => `${k}=${v}${breakdown(k)}`).join(', ')}`);
  if (partial.length) lines.push(`  Partial  : ${partial.length} site(s) hit an error/time limit but kept what was found`);
  const limited = results.filter((r) => r.rateLimited);
  if (limited.length) {
    const pages = limited.reduce((n, r) => n + r.rateLimited!, 0);
    const worst = [...limited].sort((a, b) => b.rateLimited! - a.rateLimited!).slice(0, 5).map((r) => `${host(r)} (${r.rateLimited})`);
    lines.push(`  Limited  : ${pages} page(s) skipped on ${limited.length} site(s) because the server rate-limited the scraper (HTTP 429/503): ${worst.join(', ')}; fetch them with --retry-rate-limited`);
  }
  const outOfTime = results.filter(budgetRetry);
  if (outOfTime.length) {
    const queued = (r: SiteResult) => r.budgetQueued ?? r.resume?.queued.length ?? 0;
    const pages = outOfTime.reduce((n, r) => n + queued(r), 0);
    const worst = [...outOfTime].sort((a, b) => queued(b) - queued(a)).slice(0, 5).map((r) => `${host(r)} (${queued(r) || 'browser'})`);
    lines.push(`  Out of time: ${outOfTime.length} site(s) ran out of time budget with ${pages} page(s) still queued: ${worst.join(', ')}; continue them with --retry-budget-queued (per-site budget: --budget=MIN)`);
  }
  const capped = results.filter((r) => r.capQueued || r.resume?.capped);
  if (capped.length) {
    const queued = (r: SiteResult) => r.capQueued ?? r.resume?.queued.length ?? 0;
    const pages = capped.reduce((n, r) => n + queued(r), 0);
    const worst = [...capped].sort((a, b) => queued(b) - queued(a)).slice(0, 5).map((r) => `${host(r)} (${queued(r)})`);
    lines.push(`  Capped   : ${capped.length} site(s) reached the page cap with ${pages} page(s) still queued: ${worst.join(', ')}; continue them with --retry-capped --max-pages=N (a higher cap)`);
  }
  if (top.length) lines.push(`  Top sites: ${top.map((r) => `${host(r)} (${r.emails.length})`).join(', ')}`);
  if (failed.length) lines.push(`  Failed sites:\n${failed.map((r) => `    - ${host(r)} [${r.error}${r.errorDetail ? `: ${r.errorDetail}` : ''}]`).join('\n')}`);
  if (noEmails.length) lines.push(`  No emails found on:\n${noEmails.map((r) => `    - ${host(r)}`).join('\n')}`);
  const text = lines.join('\n') + '\n';
  const counts = {
    sites: sites.length, withEmails: withEmails.length, noEmails: noEmails.length, failed: failed.length, missing,
    uniqueEmails, pagesFetched: fetched, pagesReused: reused, browserSites: results.filter((r) => r.usedBrowser).length,
  };
  log.info({ ...counts, failures: Object.fromEntries(reasons) }, '\n' + text);
  return { text, counts, reasons: Object.fromEntries(reasons) };
}

/**
 * `retry` is set for a --retry-* run: only the sites it selects are crawled, the rest come from the stored results.
 * `newOnly` keeps the stored results of a finished run too, so only sites that aren't in them are crawled.
 */
export async function processFile(db: Db, file: string, layout: FileLayout, opts: RunOptions, retry: RetryFlags | null, summaryOnly = false, newOnly = false): Promise<void> {
  const startedAt = Date.now();
  const { group: cat, base: list, outFile } = layout;
  const rel = (f: string) => path.relative(ROOT, f);
  const interrupted = !!db.runs.interrupted(cat, list);

  if (summaryOnly) {
    if (interrupted) {
      log.warn({ input: rel(file) }, `Skipping ${layout.id}: its last scrape was interrupted. Resume it first (re-run the scrape), then rebuild`);
      return;
    }
    if (!db.sites.loadList(cat, list).size) {
      log.warn({ input: rel(file) }, `Skipping ${layout.id}: no stored results to rebuild from, so ${rel(outFile)} is left untouched`);
      return;
    }
  }

  const release = db.lockList(cat, list);
  try {
    const input = readSites(file);
    const { sites } = input;
    if (input.invalid || input.duplicates) {
      log.warn({ input: rel(file), invalid: input.invalid, duplicates: input.duplicates, column: input.column }, `${layout.id}: skipped ${input.invalid} invalid and ${input.duplicates} duplicate website row(s)`);
    }
    if (!sites.length) {
      log.warn({ input: rel(file), column: input.column }, `${layout.id}: no websites found in the input (looked in column ${input.column + 1})`);
      return;
    }

    // A fresh re-scrape of a list asks again for every stored page (conditionally); anything else reuses pages up to --revalidate days old.
    const outputExists = fs.existsSync(outFile);
    const fresh = !summaryOnly && !retry && !newOnly && !interrupted && outputExists;
    const cutoff = fresh ? startedAt : startedAt - opts.revalidateDays * 86_400_000;
    const retried = retry ? [retry.failed && 'failed', retry.rateLimited && 'rate-limited', retry.budget && 'budget-queued', retry.capped && 'capped'].filter(Boolean) : [];
    let who: ListRef = { cat, list, g: db.generation(cat, list), run: runId };
    const crawlOpts: RunOptions = { ...opts };
    if (!summaryOnly) {
      const begun = db.beginList({ cat, list, run: runId, mode: retried.length ? `retry ${retried.join(' + ')}` : newOnly ? 'new-only' : 'scrape', sites: sites.length, outputExists, keep: !!retry || newOnly });
      who = begun;
      if (begun.resumed) log.info({ generation: begun.g }, `${layout.id}: resuming an interrupted scrape from its stored results`);
      if (begun.fresh) log.info({ generation: begun.g }, `${layout.id}: scraping again; the earlier results stay in the database as generation ${begun.g - 1}`);
      // Every page fetched is kept, here and in later runs, whatever the category: a page is not requested twice.
      const store = db.pagesFor({ cat, list, run: runId });
      crawlOpts.pages = store;
      crawlOpts.pagesCutoff = cutoff;
      if (store.pages) log.info({ pages: store.pages }, `${layout.id}: ${store.pages} pages already scraped are reused unless older than ${fresh ? 'this run' : `${opts.revalidateDays} days`}`);
    }
    const done = db.sites.loadList(cat, list, who.g);
    // Re-crawled rows that had emails: kept as they were, plus any new emails the re-crawl finds (mergeResults).
    let previous = new Map<string, SiteResult>();
    const resumes = new Map<string, { prev: SiteResult; parts: ResumeParts }>();
    if (retry) {
      const plan = planRetries(done, retry);
      previous = plan.previous;
      for (const [site, parts] of plan.resume) resumes.set(site, { prev: done.get(site)!, parts });
      for (const site of [...plan.recrawl, ...plan.resume.keys()]) done.delete(site);
      // Rows being redone stay stored until their new row supersedes them (the latest row of a site wins), so an
      // interrupted retry loses nothing. Only failures with nothing found are dropped, to be scraped again.
      for (const site of plan.recrawl) if (!previous.has(site)) db.sites.drop(who, site);
      log.info({ recrawl: plan.recrawl.size, resume: plan.resume.size }, `${layout.id}: retrying ${plan.recrawl.size + plan.resume.size} site(s): ${plan.recrawl.size} crawled again from the start, ${plan.resume.size} continued from where they stopped`);
    }
    log.info({ input: rel(file), sites: sites.length, stored: done.size }, `\n=== ${layout.id}: ${sites.length} sites (${done.size} stored) ===`);
    if (newOnly && !summaryOnly) log.info({ new: sites.filter((s) => !done.has(s)).length }, `${layout.id}: --new-only: ${sites.filter((s) => !done.has(s)).length} new site(s) to scrape, the stored ones are kept`);

    let n = sites.filter((s) => done.has(s)).length;
    const limit = pLimit(opts.concurrency);
    await Promise.all(
      sites.map((site) =>
        limit(() => withLogContext({ site }, async () => {
          if (done.has(site) || summaryOnly) return;
          const t0 = Date.now();
          log.debug('site started');
          const from = resumes.get(site);
          let r = await runSite(site, crawlOpts, from);
          const prev = previous.get(site);
          if (prev) {
            const merged = mergeResults(prev, r);
            const added = merged.emails.length - prev.emails.length;
            log.info({ emails: r.emails.length, previousEmails: prev.emails.length, mergedEmails: merged.emails.length }, `re-crawl found ${r.emails.length} emails; with the ${prev.emails.length} found before that makes ${merged.emails.length} (${added} new)`);
            r = merged;
          }
          done.set(site, r);
          db.sites.append(who, r);
          n++;
          const ms = Date.now() - t0;
          const fields = { finalUrl: r.finalUrl, emails: r.emails.length, pages: r.pages, usedBrowser: r.usedBrowser, error: r.error, durationMs: ms };
          const resumed = from ? ` (resumed: +${r.emails.length - from.prev.emails.length} emails, +${r.pages - from.prev.pages} pages)` : '';
          const msg = `[${n}/${sites.length}] ${baseHost(new URL(site).hostname)} — ${r.emails.length} emails, ${r.pages} pages${r.reused ? ` (${r.reused} reused)` : ''}${resumed}${r.usedBrowser ? ', browser' : ''}${r.rateLimited ? `, ${r.rateLimited} pages rate-limited` : ''}${r.budgetQueued ? `, ${r.budgetQueued} queued at time limit` : ''}${r.error ? `, ${r.error}` : ''} (${(ms / 1000).toFixed(0)}s)`;
          if (r.error && !r.emails.length) log.warn(fields, msg);
          else log.info(fields, msg);
        })),
      ),
    );

    // Outputs use the current rules even for stored rows; the database keeps what was scraped.
    const { checked, mxDropped } = await checkedResults(done, !!opts.checkMx);
    const assigned = assignRows(sites, checked, input.names);
    const { rows } = assigned;
    writeCsv(outFile, rows);
    const withEmails = sites.filter((s) => (checked.get(s)?.emails.length ?? 0) > 0).length;
    const failed = sites.filter((s) => { const r = checked.get(s); return r?.error && !r.emails.length; }).length;
    log.info({ output: rel(outFile), emails: rows.length, withEmails, failed }, `=> ${rel(outFile)}: ${rows.length} emails from ${withEmails}/${sites.length} sites (${failed} failed/unreachable)`);
    const mode = summaryOnly ? 'summary rebuilt from stored results' : `${retried.length ? `retry ${retried.join(' + ')}` : 'scrape'}: ${describe(opts)}`;
    const summary = summarize(layout, sites, checked, assigned, mode, startedAt, mxDropped);
    if (opts.filter) writeFiltered(db, layout, rows, opts.filter);
    // The end of the list. A scrape cut off before this line is resumed by the next run.
    db.runs.append({
      t: 'list.end', run: runId, cat, list, g: who.g, status: 'finished', mode: summaryOnly ? 'summary' : retried.length ? 'retry' : newOnly ? 'new-only' : 'scrape',
      durationMs: Date.now() - startedAt, csv: rel(outFile), counts: summary.counts, reasons: summary.reasons, text: summary.text,
    });
  } finally {
    release();
  }
}

function readRows(file: string): Row[] {
  const rows = parse(fs.readFileSync(file), { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  return rows.filter((r) => r.email).map((r) => [r.name ?? '', r.email, r.website ?? '', r.link ?? '']);
}

/**
 * --unique: every email once across the given output CSVs, written to `outFile`. Reads finished outputs only;
 * per-file CSVs and the database are left alone and nothing is scraped. `label` names the combined file; `cat` is
 * its category (null for a list spanning several).
 */
export function writeUnique(db: Db, inputs: { id: string; file: string }[], label: string, outFile: string, cat: string | null, filter?: SuffixFilter): void {
  const startedAt = Date.now();
  const files: { base: string; rows: Row[] }[] = [];
  const missing: string[] = [];
  for (const { id, file } of inputs) {
    if (!fs.existsSync(file)) { missing.push(id); continue; }
    files.push({ base: id, rows: readRows(file) });
  }
  if (missing.length) log.warn({ missing }, `--unique: no output yet for ${missing.join(', ')}; skipped`);
  if (!files.length) { log.warn(`--unique ${label}: no output CSVs to combine`); return; }

  const { rows, read, overlaps } = uniqueRows(files);
  writeCsv(outFile, rows);
  // The filter is applied to the combined list, so an email dropped from one file can't come back from another.
  let filtered = '';
  if (filter) {
    const { kept, dropped } = filterRows(rows, filter);
    const out = path.join(path.dirname(outFile), `${path.basename(outFile, '.csv')}.${filterTag(filter)}.csv`);
    writeCsv(out, kept);
    filtered = filterSummary(`unique ${label}`, filter, rows.length, kept.length, dropped, path.relative(ROOT, out));
  }

  const top = [...overlaps].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const text = [
    `=== unique ${label} — ${new Date(startedAt).toISOString()} (run ${runId}) ===`,
    `  Files    : ${files.length} (${files.map((f) => `${f.base} ${f.rows.length}`).join(', ')})`,
    `  Rows     : ${read} read, ${read - rows.length} duplicate(s) removed`,
    `  Emails   : ${rows.length} unique -> ${path.relative(ROOT, outFile)}`,
    ...(top.length ? [`  Overlap  : ${top.map(([k, n]) => `${k} ${n}`).join('; ')}`] : []),
    '',
  ].join('\n') + filtered;
  db.runs.append({ t: 'unique.end', run: runId, cat, label, csv: path.relative(ROOT, outFile), files: files.length, rowsRead: read, uniqueEmails: rows.length, text });
  log.info({ output: path.relative(ROOT, outFile), files: files.length, rowsRead: read, uniqueEmails: rows.length }, '\n' + text);
}

/**
 * --unique with no files: one combined list per category, written inside it (results/emails/<category>/unique/<category>.csv).
 * With files: the files' own category if they share one (results/emails/<category>/unique/<label>.csv), else a cross-category
 * list in results/emails/unique/.
 */
export function runUnique(db: Db, fileArgs: string[], filter?: SuffixFilter): void {
  if (!fileArgs.length) {
    for (const [group, csvs] of findOutputs(OUT_DIR)) {
      const l = fileLayout(group, group);
      const inputs = csvs.map((file) => ({ id: path.basename(file, '.csv'), file }));
      writeUnique(db, inputs, group, path.join(l.uniqueDir, `${group}.csv`), group, filter);
    }
    return;
  }
  const items = fileArgs.map((f) => {
    const group = groupOf(f);
    const base = path.basename(f, path.extname(f));
    return { group, id: `${group}/${base}`, file: fileLayout(group, base).outFile };
  });
  const uniq = [...new Map(items.map((i) => [i.id, i])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Set(uniq.map((i) => i.group));
  const label = uniqueLabel(uniq.map((i) => path.basename(i.file, '.csv')));
  if (groups.size === 1) {
    const l = fileLayout([...groups][0], label);
    writeUnique(db, uniq, label, path.join(l.uniqueDir, `${label}.csv`), [...groups][0], filter);
  } else {
    writeUnique(db, uniq, label, path.join(crossUniqueDir(), `${label}.csv`), null, filter);
  }
}

/** --dry-run: what processFile would do with one file. Reads the input and the database; writes nothing and takes no lock. */
export function previewFile(db: Db, file: string, layout: FileLayout, retry: RetryFlags | null, summaryOnly: boolean, newOnly = false, filter?: SuffixFilter): string {
  const text = previewBase(db, file, layout, retry, summaryOnly, newOnly);
  return filter && !/would (be )?skipped?|would fail/.test(text) ? `${text}; then would write the filtered CSV ${path.relative(ROOT, filteredPath(layout, filter))}` : text;
}

function previewBase(db: Db, file: string, layout: FileLayout, retry: RetryFlags | null, summaryOnly: boolean, newOnly: boolean): string {
  const { group: cat, base: list } = layout;
  let input: ReturnType<typeof readSites>;
  try {
    input = readSites(file);
  } catch (err) {
    return `${layout.id}: would fail: ${(err as Error).message}`;
  }
  const n = input.sites.length;
  const skipped = input.invalid || input.duplicates ? ` (${input.invalid} invalid and ${input.duplicates} duplicate row(s) skipped)` : '';
  const holder = lockPid(db.listLockFile(cat, list));
  if (holder && pidAlive(holder)) return `${layout.id}: in use by another run (pid ${holder}); would be skipped`;
  if (!n) return `${layout.id}: no websites in the input; would be skipped`;
  const done = db.sites.loadList(cat, list);
  const cached = input.sites.filter((s) => done.has(s)).length;
  const interrupted = !!db.runs.interrupted(cat, list);
  const hasOutput = fs.existsSync(layout.outFile);
  if (summaryOnly) {
    if (interrupted) return `${layout.id}: its last scrape was interrupted; would be skipped (resume it first)`;
    if (!done.size) return `${layout.id}: no stored results to rebuild from; would be skipped`;
    return `${layout.id}: would rebuild the CSV and summary from ${cached} of ${n} stored sites${skipped}`;
  }
  if (retry) {
    const inInput = new Map(input.sites.filter((s) => done.has(s)).map((s) => [s, done.get(s)!]));
    const plan = planRetries(inInput, retry);
    return `${layout.id}: would re-crawl ${plan.recrawl.size} and continue ${plan.resume.size} of ${n} sites${n - cached ? `, and scrape ${n - cached} not scraped yet` : ''}${skipped}`;
  }
  if (newOnly) return `${layout.id}: ${n - cached ? `would scrape ${n - cached} new sites; ${cached} stored sites reused` : `nothing new (all ${n} sites stored); would only rebuild the CSV and summary`}${skipped}`;
  if (interrupted) return `${layout.id}: would resume an interrupted scrape: ${cached} of ${n} sites stored, ${n - cached} to scrape${skipped}`;
  if (hasOutput) return `${layout.id}: would scrape all ${n} sites again (the current results stay in the database as an earlier generation)${skipped}`;
  return `${layout.id}: would scrape ${n - cached} sites${cached ? ` (${cached} more already stored by an earlier run)` : ''}${skipped}`;
}

/** --dry-run: interrupted lists whose input list is gone, and locks left by runs that died. */
export function staleState(db: Db, inputs: string[]): string[] {
  const out: string[] = [];
  const known = new Set(inputs.map((f) => `${groupOf(f)}/${path.basename(f, path.extname(f))}`));
  for (const { cat, list, start } of db.runs.interruptedLists()) {
    if (!known.has(`${cat}/${list}`)) out.push(`${cat}/${list}: an interrupted scrape (run ${start.run}) whose input list is gone (not under websites/)`);
  }
  if (fs.existsSync(db.files.locksDir)) {
    for (const f of fs.readdirSync(db.files.locksDir)) {
      if (!f.endsWith('.lock')) continue;
      const pid = lockPid(path.join(db.files.locksDir, f));
      if (!pid || !pidAlive(pid)) out.push(`${path.relative(ROOT, path.join(db.files.locksDir, f))}: left by a run that is gone (pid ${pid || '?'}); the next run takes it over`);
    }
  }
  return out;
}
