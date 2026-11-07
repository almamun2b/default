# AGENTS.md

Operating guide for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. For what the tool does, see [README.md](README.md). For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The recurring job

The owner regularly drops a CSV of websites into `websites/<category>/` (`healthcare`, `martial-arts`, `dealers`, or a new folder for a new kind of list) and asks the agent to "extract emails" from it. The agent runs the scraper and reports results. Output goes to `results/emails/<category>/<same-file-name>.csv` with columns **`name,email,website,link`** (with the `--unique` lists in `unique/` and the suffix-filtered CSVs in `filtered/` beside them), and the summary of the run is recorded in `results/db/run-history.jsonl` (the `text` of its `list.end` event). Everything the scraper remembers lives in the one database folder `results/db/`: `pages.jsonl` (every page ever fetched, for all categories), `sites.jsonl` (each list's per-site results) and `run-history.jsonl`. There are no per-category `.cache/` or `logs/` folders. `db`, `emails` and `unique` can't be category names. A CSV placed directly in `websites/` has no category and gets its own folder, `results/emails/<file-name>/`; if the owner hasn't said which category a new list belongs to, ask, or put it in a new category folder named after what it is.

Standard procedure:

1. Check the input: `head -5 websites/<category>/<file>.csv` and `wc -l websites/<category>/<file>.csv`. Any header named `website`/`url`/`domain`/`site`/`websites`/`link` works; otherwise the most URL-like column is used. A `name` column (or `business name`, `church name`, …) becomes the row name when no person or department name is found. `npm run scrape -- <file> --dry-run` shows what a command would do without running it.
2. Run it in the background, because it takes about 1–2 hours per 150 sites with the default deep crawl (30–60 minutes with `--quick`):
   ```bash
   nohup npm run scrape -- websites/<category>/<file>.csv > <scratch>/run.log 2>&1 &
   ```
   Plain `npm run scrape` processes every input file that has no output yet.
3. Watch progress in the log. Each site prints `[n/N] host — X emails, Y pages …`. The run for a file ends with a `=>` line and the summary block.
4. If the run says a file is "in use by another run", another scrape holds `results/db/locks/<category>.<file>.lock` (or `pages.lock`: only one scrape runs at a time). Don't delete the lock; find and wait for that PID.
5. Report per-file totals from the summary: websites with emails, websites with no emails, failed websites grouped by reason and detail (`unreachable=12 (dns=8, http-403=4)`; `browser-error` means Chromium crashed on that site; `robots-unavailable` is a robots.txt server error, retried by `--retry-failed`), unique emails, the name breakdown. Mention noteworthy failures. Check `logs/error-<date>.log` (JSON lines, `npx pino-pretty < file` to read) and report any errors from the run (match its `runId`). For a site that failed for unclear reasons, re-run it alone with `--log-level=debug`.
6. Offer the retry that matches what the summary shows. They are separate flags, can be combined, reuse the stored results and keep everything else:
   - `Failures` (many `unreachable`/`timeout`, often transient): `--retry-failed` crawls those sites again from the start.
   - `Limited` (servers answered 429/503): `--retry-rate-limited` fetches only the refused pages (and new links on them), with the automatic per-server slow-down. If it stays large, add `--host-concurrency=1` or `--concurrency=6`.
   - `Out of time` (sites ran out of budget with pages queued): `--retry-budget-queued --budget=MIN` continues them from the saved queue without refetching anything. Suggest a budget that fits: sites with `Crawl-delay: 10` get only about 6 pages a minute.
   - `Capped` (sites reached `--max-pages` with pages queued): only if the owner wants deeper coverage, `--retry-capped --max-pages=N` (N above the cap they stopped at) continues them. Contact-like pages are already fetched first, so this is rarely needed.

   Sites from runs before this feature have no saved queue. `npx tsx scripts/mark-budget-from-logs.ts` shows which ones the logs say ran out of time; with `--write` (ask the owner first, and only when no run is working on those files) it marks them so `--retry-budget-queued` re-crawls them. A re-crawled site keeps its earlier row exactly as it was; only new emails are added.

## Commands

| Task | Command |
|---|---|
| Install | `npm install && npx playwright install chromium` |
| Type-check | `npm run typecheck` |
| Tests (no network needed) | `npm test` |
| See what the current rules would change in existing outputs (writes nothing) | `npx tsx scripts/recheck-cache.ts` |
| Scrape new input files | `npm run scrape` |
| Scrape specific files (like a plain run: finished lists are skipped, interrupted ones resume; add `--force` to re-scrape) | `npm run scrape -- websites/dealers/a.csv` |
| Re-scrape everything | `npm run scrape -- --force` |
| Scrape only the sites added to a list that was already scraped (stored results kept) | `npm run scrape -- --new-only websites/dealers/a.csv` |
| Re-scrape only failed sites (no emails) | `npm run scrape -- --retry-failed` |
| Fetch the pages servers refused with 429/503 | `npm run scrape -- --retry-rate-limited` |
| Continue sites that ran out of time budget | `npm run scrape -- --retry-budget-queued --budget=60` |
| Continue sites that reached the page cap | `npm run scrape -- --retry-capped --max-pages=800` |
| Ask again about stored pages older than N days (default 30); with no number, about every stored page once | `--revalidate=N` / `--revalidate` |
| Show what a command would do, without running it | add `--dry-run` |
| Drop emails whose domain can't receive mail (DNS only) | add `--check-mx` (e.g. with `--summary-only`) |
| List every option | `npm run scrape -- --help` |
| Mark sites that ran out of time before the queue was saved (dry run; `--write` to apply) | `npx tsx scripts/mark-budget-from-logs.ts` |
| Rebuild CSVs and summaries from the stored results with the current rules, no network | `npm run scrape -- --summary-only` |
| One list per category with each email once, no network (`results/emails/<category>/unique/<category>.csv`) | `npm run scrape -- --unique` |
| Same for only some files (`results/emails/dealers/unique/au.csv`) | `npm run scrape -- --unique websites/dealers/au.*.csv` |
| Also write only the emails whose domain ends with / doesn't end with some suffixes (`results/emails/<category>/filtered/<name>.<filter>.csv`; with `--unique`, `unique/<label>.<filter>.csv`) | add `--include-suffix=.com,.au` / `--exclude-suffix=.gov,.edu` (quote the `[..]` form) |
| Verbose diagnostics in the root `logs/` | `npm run scrape -- websites/dealers/a.csv --log-level=debug` |
| Lighter, faster crawl (150 pages, 10 min/site) | `npm run scrape -- --quick` |
| Tune limits (any combination) | `--max-pages=N --browser-pages=N --max-depth=N --budget=MIN --concurrency=N --page-concurrency=N --host-concurrency=N` |

Deep crawl is the default: no page cap (`--max-pages=0`), 60 browser pages, unlimited depth (`--max-depth=0`), 20 min per site. Use it for dealer, tourism and other large-site lists. Use `--quick` only when the owner wants speed over coverage. All flags are documented in README.md under "Crawl options".

Run `npm run typecheck` and `npm test` after every change, and add a test for each fix in `test/` (crawler tests use the local server in `test/helpers/server.ts`). For a quick look at one real site or snippet, use a throwaway `.mts` script (ESM, top-level `await` allowed) run with `npx tsx`, and put it outside the repo:

```ts
// scratch/check.mts
import { scrapeSite, closeBrowser } from '/abs/path/to/src/crawler.ts';
import { extractFromHtml } from '/abs/path/to/src/extract.ts';
console.log(extractFromHtml('<a href="mailto:jane@x.co.nz">Dr Jane Smith</a>'));
const r = await scrapeSite('https://lumino.co.nz/');
console.log(r.error, r.pages, r.emails);
await closeBrowser();
```

Regression baseline: `https://lumino.co.nz/` gives 11 emails with the deep defaults, which have no page cap (it was 6 when the cap was 400; 3 with `QUICK_OPTIONS`), including `craig.kirkland@lumino.co.nz` named "Craig Kirkland". `https://adhb.health.nz/` gives `robots-disallowed`.

After changing anything in `extract.ts`, run `npx tsx scripts/recheck-cache.ts` and review the dropped emails and removed or changed names against the 13k stored rows. Look for lost real people as well as junk that got through.

For an end-to-end check, write a 2–4 row sample CSV outside `websites/` and run `npm run scrape -- <path>`. Run it against a scratch results folder so the real database is untouched: `SCRAPER_RESULTS_DIR=/tmp/sample-results npm run scrape -- <path>`. Then delete that scratch folder (`/tmp/sample-results`); that is the only database cleanup allowed, because it was never the owner's data.

## Rules the owner has set

- **Output columns are exactly `name,email,website,link`.** `website` is the input URL and `link` is the page the email was found on. `name` falls back in this order: person name, then department page title, then the input's own name column, then the scraped business name (owner decision 2026-10-13).
- **Each email is credited to the site that owns it** (its domain), else where it wasn't only in raw HTML, else the first site. There is no `shared/` file: every email stays in its list's own CSV (owner decision 2026-10-16).
- **A re-crawled site keeps its old row; only new emails are added** (owner decision 2026-10-13).
- **Never delete or edit anything in `results/db/`.** The owner keeps it for future improvements (and the move to SQLite). It is append-only: a fresh re-scrape starts a new generation of the list's rows and leaves the old ones in the file. `pages.jsonl` holds every page ever fetched (a page is never scraped twice, in any category; stored pages are revalidated after 30 days, `--revalidate=N` changes that). `pages.idx` and `sites.idx` are derived indexes: they may be deleted and are rebuilt (slowly, once). Never delete a lock in `results/db/locks/` while its PID is alive. The old per-category `results/<category>/.cache/`, `logs/` and `emails/` folders were imported and deleted by the owner on 2026-11-07; `src/db/migrate.ts` stays for an old checkout, and never deletes anything itself.
- **Don't re-scrape existing outputs unless asked.** Code changes apply to future runs; the owner decides when to re-run. That includes `--summary-only`: it rebuilds existing CSVs with the current rules, so only run it when asked.
- **Email filters apply to outputs only** (owner decision 2026-10-23). `--include-suffix` / `--exclude-suffix` never change what is scraped or stored and never change the normal CSV; they add a file named after the filter in `results/emails/<category>/filtered/` (`unique/` for `--unique`). A suffix matches at a dot (`.gov` does not match `x.gov.au`); include and exclude combine. A list that isn't being scraped is filtered from its stored results. There is deliberately no country filter. Don't filter inside the crawler or `extract.ts`.
- **Respect robots.txt**, including on the host reached after a redirect, on every redirect hop, on the site's `www.`/`http:` variants (each origin by its own robots.txt), and in the browser fallback, Crawl-delay included. Don't add bypasses.
- **Each summary is recorded** in `results/db/run-history.jsonl` after every run (the `text` of its `list.end`, `filter.end` or `unique.end` event). Keep that behaviour for any new mode.
- `websites/`, `results/` and `logs` are git-ignored data. Never commit them.
- **No agent attribution in git** (owner decision 2026-10-29). Every commit, amend, rebase, merge, pull, push, tag and PR is made as the owner, never as Claude or any agent. No `Co-Authored-By`, `Claude-Session` or "Generated with …" lines in commit messages or PR bodies, and never set or override the git identity (`git config user.*`, `-c user.name`, `--author`): commit with the owner's active git config. If the active identity is `Claude <noreply@anthropic.com>` (cloud or sandbox sessions), don't commit; tell the owner.

## Building website lists

When the owner asks to find, search or generate websites for a category (any sector, e.g. "all dentists in NZ" or "all pizza shops in AU and NZ"):

- **Where and what:** `websites/<topic>-<au|nz>/<list>.<au|nz>.csv` with header `name,website`, one row per business site. The same topic in AU and NZ gets one folder each (`dentists-au`, `dentists-nz`). Any sector is fine; a new topic is a new folder.
- **Never edit or overwrite an existing list** (owner decision 2026-10-29). If `<list>.<cc>.csv` exists, write `<list>-2.<cc>.csv`, then `-3`, … (the next free number; the unnumbered file counts as 1). Chains follow the same rule (`chains-2.au.csv`). `scripts/new-list.ts` picks the number. **One unscraped numbered file per list** (owner decision 2026-10-29, replaces the per-session rule): all new sites that have not been scraped yet are collected in the list's highest numbered file (`pizza-shops-2.au.csv`), from any source and in any session, added with `new-list.ts --append`. Start the next number (`-3`) only once that file has been scraped (its output exists in `results/emails/<category>/`). Never merge into or append to the unnumbered base list. The end-to-end method for any sector and country (sources, scripts, examples) is [docs/finding-target-websites.md](docs/finding-target-websites.md); web search for places without a website is [docs/finding-websites-by-web-search.md](docs/finding-websites-by-web-search.md). `scripts/validate-lists.ts` checks lists for duplicates, platforms and invalid URLs; `--only-country` (on it and on `new-list.ts`) also drops domains of other countries, keeping generic ones and the target country's.
- **A new numbered file holds only new sites:** anything already in any CSV of that category folder (same host + path, as `readSites()` dedupes) and in-file duplicates are dropped. That way `npm run scrape` only crawls the new file.
- **Keep** the business's own website. **Drop** social pages, delivery/ordering platforms (ubereats, menulog, doordash, facebook, instagram, linktr.ee, tripadvisor, yelp …), directories, and businesses that are not about the topic (the topic must show in the name, a tag or the site, not just a broad type like "restaurant").
- **Scope for a sector** is places whose tag, name or site shows the topic (pizza: `cuisine=pizza`, "pizz" in the name), not every broader type (Italian restaurants, pubs that list pizza). Chains go in their own `<topic>-chains` list, numbered the same way.
- **Targets:** the owner's per-country target for the sector (for example pizza: AU 5,000–8,100, NZ as many as exist) is reported against the real count. Never pad with unrelated businesses and never invent sites. Report per country: new sites, duplicates dropped, total in the category, sources used, and the shortfall.
- **Sources, in order:** Overture Maps (`scripts/overture-places.py <CC> <out.csv> --category=…`, the bulk source), OpenStreetMap through Overpass (`scripts/fetch-osm-places.ts <cc> <out.csv> --match=…`, selectors in its header), then public directories and web search for gaps, then a Google Places API key only if the owner gives one. Respect each source's terms and rate limits.
- **Procedure:** write candidates to the scratchpad, run `scripts/new-list.ts` (use `--dry-run` first), look at a sample, report. Don't scrape emails from a new list until the owner asks.

## Process hygiene

- Long runs go in the background with `nohup … &`. Wait on the **PID** (`while kill -0 <pid>; do sleep 30; done`).
- To stop a run, `kill` the PID printed in its first log line (`Run <id> started (pid N)`). Killing the `npm` PID does not reach the scraper and leaves it running.
- **Never** wait with `pgrep -f` or kill with `pkill -f` using a pattern that also appears in your own shell command. It matches itself, so the wait never ends or the kill takes out your own shell. This has happened here before.
- Two runs can't work on the same file: the second one skips it (`<file>.lock` holds the first run's PID). Never delete a lock by hand while that PID is alive.
- If a run is interrupted, re-running the same command (or a plain `npm run scrape`) resumes from the stored results, also for interrupted `--force` re-scrapes (a `list.start` without a `list.end` in the run history marks them). Don't edit the history or the stored rows. An interrupted `--retry-*` run continues when the same command is run again.

## Code conventions

- ESM TypeScript run directly by `tsx`. There is no build output. Relative imports use the `.js` extension (`from './urls.js'`).
- The heuristics are tuned against real NZ healthcare and AU dealer/tourism sites. When changing `extract.ts` filters or name rules, run `scripts/recheck-cache.ts` and re-check a few known sites, looking for regressions: false person names, junk emails, lost emails. Keep regexes linear (anchor on literals, bound repetitions); a quadratic one can freeze the whole run.
- The CSV and the summary are always derived from `SiteResult` objects, whether fresh or stored, after `recheckSite()`. New fields must be optional, because old stored rows lack them (`budgetQueued`, `capQueued`, `errorDetail` and `resume` only exist from cache v3).
- After changing `output.ts` row assignment as well as `extract.ts`, run `npx tsx scripts/recheck-cache.ts`: it also previews which emails would be credited to another site.
- Keep comments sparse and explain *why*, matching the existing code.
