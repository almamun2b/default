import type { ResumeParts, SiteResult } from './crawler.js';

/**
 * Which stored site results a retry run redoes, and how. Where the results live (results/db/sites.jsonl) is the
 * business of src/db/; this file only decides, from a list's rows, what each --retry-* flag selects.
 */

// None of the retries touches a robots.txt block: that won't change.

/** --retry-failed: a failure with nothing found. */
export function failedRetry(r: SiteResult): boolean {
  return !!r.error && r.error !== 'robots-disallowed' && r.emails.length === 0;
}

/** --retry-rate-limited: pages the server refused with 429/503. v3 rows list them; older rows only count them. */
export function rateLimitedRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return (r.v ?? 0) >= 3 ? !!r.resume?.limited.length : (r.rateLimited ?? 0) > 0;
}

/** --retry-budget-queued: the time budget ran out with pages still queued, or before the browser phase ran. */
export function budgetRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return (r.budgetQueued ?? 0) > 0 || (!!r.resume?.queued.length && !r.resume.capped) || !!r.resume?.browser;
}

/** --retry-capped: the page cap (--max-pages) was reached with pages still queued (v3 rows only). */
export function cappedRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return !!r.resume?.capped && r.resume.queued.length > 0;
}

export interface RetryFlags {
  failed: boolean;
  rateLimited: boolean;
  budget: boolean;
  capped?: boolean;
}

export interface RetryPlan {
  recrawl: Set<string>; // crawled again from the start
  resume: Map<string, ResumeParts>; // continued from their saved state (resumeSite)
  previous: Map<string, SiteResult>; // re-crawled rows with emails: kept, plus the new emails a re-crawl finds (mergeResults)
}

/**
 * Which cached sites a retry run redoes, and how. A failure is crawled again from the start. Rate-limited
 * pages and a queue left by the time budget are continued from the row's saved state; a row without one
 * (scraped before v3, or marked from the logs) is crawled again instead; its row is kept and only new emails are added.
 */
export function planRetries(done: Map<string, SiteResult>, flags: RetryFlags): RetryPlan {
  const plan: RetryPlan = { recrawl: new Set(), resume: new Map(), previous: new Map() };
  for (const [site, r] of done) {
    if (flags.failed && failedRetry(r)) {
      plan.recrawl.add(site);
      continue;
    }
    const parts: ResumeParts = { budget: flags.budget && budgetRetry(r), limited: flags.rateLimited && rateLimitedRetry(r), capped: !!flags.capped && cappedRetry(r) };
    if (!parts.budget && !parts.limited && !parts.capped) continue;
    const s = r.resume;
    // A capped row always has its queue saved, so only the other parts can send a row back to a full re-crawl.
    const saved = (!parts.budget || !!((s?.queued.length && !s.capped) || s?.browser || (s?.capped && parts.capped))) && (!parts.limited || !!s?.limited.length);
    if (saved) {
      plan.resume.set(site, parts);
    } else {
      plan.recrawl.add(site);
      if (r.emails.length) plan.previous.set(site, r);
    }
  }
  return plan;
}
