# Email Scraper

Crawls every website listed in a CSV file and extracts every email address it can find. Each input file produces an output CSV with one row per unique email, plus a summary in the run history.

```
websites/healthcare-nz/dentists.nz.csv   ──►   results/emails/healthcare-nz/dentists.nz.csv
(list of websites, in a category folder)        (name, email, website, link)
                                                results/db/  (every page, every site's result, the run summaries)
```

Built with TypeScript on Node.js. It uses [cheerio](https://cheerio.js.org/) to parse HTML and [Playwright](https://playwright.dev/) (headless Chromium) as a fallback for JavaScript-rendered sites.

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Categories](#categories)
- [Input format](#input-format)
- [Output format](#output-format)
- [Command reference](#command-reference)
- [Crawl options (depth and limits)](#crawl-options-depth-and-limits)
- [Running long jobs](#running-long-jobs)
- [Retrying and continuing sites](#retrying-and-continuing-sites)
- [Running the Australian lists](#running-the-australian-lists)
- [Run summaries](#run-summaries)
- [Diagnostic logs](#diagnostic-logs)
- [The database and resuming](#the-database-and-resuming)
- [How it works](#how-it-works)
- [Tuning](#tuning)
- [Limitations](#limitations)
- [Responsible use](#responsible-use)
- [Project layout](#project-layout)

---

## Requirements

- Node.js 20.11 or newer (uses `import.meta.dirname`; developed on v24)
- npm
- About 300 MB of disk space for Playwright's Chromium

## Installation

```bash
npm install
```

```bash
npx playwright install chromium
```

Check that everything compiles and the tests pass:

```bash
npm run typecheck
```

```bash
npm test
```

## Quick start

1. Put a CSV of websites in a category folder under `websites/`, for example `websites/healthcare-nz/vets.nz.csv` (see [Categories](#categories)):

   ```csv
   website
   https://carevets.co.nz
   vetent.co.nz
   ```

2. Run the scraper:

   ```bash
   npm run scrape
   ```

3. Collect the results from `results/healthcare-nz/emails/vets.nz.csv`. The summary is in `results/db/run-history.jsonl` (also printed at the end of the run).

With no arguments, `npm run scrape` processes only files in `websites/` (and its category folders) that don't have an output yet, so you can keep adding lists and re-running the same command.

## Categories

A website list belongs to the category named by its folder. Its output CSVs go into a folder of the same name under `results/emails/`; everything the scraper remembers goes into the one database folder `results/db/` (see [The database and resuming](#the-database-and-resuming)):

```
websites/car-dealers-au/ford.au.csv   ──►   results/emails/car-dealers-au/ford.au.csv
                                            results/emails/car-dealers-au/unique/car-dealers-au.csv   (from --unique)
                                            results/emails/car-dealers-au/filtered/ford.au.<filter>.csv   (from --include-suffix / --exclude-suffix)
                                            results/db/   (pages, site results and the summary of the run, for all categories)
```

- Current categories: `auto-repair-au`, `auto-repair-nz`, `car-dealers-au`, `car-dealers-nz`, `churches-au`, `entertainments-au`, `gifts-au`, `healthcare-nz`, `martial-arts-au`, `pizza-au`, `pizza-nz`, `political-au`, `political-nz`. A category is named for its topic and country (e.g. `healthcare-nz`); a new category is just a new folder: create `websites/<category>/` and put the CSVs in it. Only one level of folders counts.
- A CSV placed directly in `websites/` (or given from outside it) has no category and gets its own folder named after the file: `websites/clinics.csv` writes to `results/emails/clinics/clinics.csv`. `db`, `emails` and `unique` can't be category names.
- Lists are never edited when more sites are found for the same category and name: the new sites go into `<list>-2.<cc>.csv`, then `-3` only once `-2` has been scraped; until then further batches are appended to the same unscraped file (for example `dentists.au.csv` → `dentists-2.au.csv`), holding only sites not already in the category. `scripts/new-list.ts` does this; see "Building website lists" in AGENTS.md.
- Two lists with the same file name in different categories are fine. Two inputs that would write the same output file are an error.

## Input format

- Any `.csv` file.
- The website column is found by its header: an exact `website`, `url`, `domain`, `site`, `websites` or `link` (case-insensitive) first, then any header containing `web`, `url`, `domain`, `site` or `link` (such as `Company Website`). Failing that, the column with the most URL-like values is used, and its first row is treated as a header if it isn't a URL.
- Invalid and duplicate rows are skipped and counted in a warning. A file with no usable websites is skipped with a warning instead of producing an empty output.
- Values may be full URLs (`https://www.example.co.nz/`) or bare domains (`example.co.nz`). `https://` is added when missing. The common typo `www./example.com` is repaired. Hosts without a real domain (`www.`, `a..b.com`, an unknown TLD) are counted as invalid rows.
- Duplicate rows are ignored, including `www.` vs non-`www.` versions. Rows are compared by **domain + path + query string**, so several pages on one domain are kept as separate sites. For example, two dealers hosted on one dealer-group site (`group.com.au/ford-a`, `group.com.au/ford-b`) are crawled separately.
- A URL with a path (`https://example.org/clinics/auckland`) focuses the crawl on that section of the site. See [Section-focused crawling](#section-focused-crawling).
- A **name column** (header `name`, or `business name`, `company name`, `practice name`, `church name`, …) is used as the row's name when no person or department name is found, before the name scraped from the site. It is read from the input every time, never cached, so fixing a name in the input fixes the output on the next `--summary-only`.
- Files saved by Excel as "Unicode text" (UTF-16, tab-separated) are read too. A stray quote inside a field is tolerated; a file that still can't be parsed is skipped with the line number, and the run carries on with the other files.

## Output format

`results/emails/<category>/<input-file-name>.csv` (for a list with no category, `results/emails/<input-file-name>/<input-file-name>.csv`):

| Column | Meaning |
|---|---|
| `name` | Best name for the email, never blank: a **person name** if one is clearly tied to the email, else the **business it belongs to** (the input's own name or the scraped business name for the site's own addresses, the domain for another company's), with a branch or department mailbox appended (`Acme Electrical - Geebung`), or the **department page title** (e.g. `Audiology — Auckland`) for a role mailbox on a section's sub-page. See "How names are chosen" |
| `email` | The email address, lower-cased |
| `website` | The website URL from the input CSV |
| `link` | The page the email was found on |

Example:

```csv
name,email,website,link
Craig Kirkland,craig.kirkland@lumino.co.nz,https://lumino.co.nz/,https://lumino.co.nz/start-your-lumino-journey/
Lumino The Dentists,henderson@lumino.co.nz,https://lumino.co.nz/,https://lumino.co.nz/dentists/henderson-dental-practice/
```

Rules:
- **One row per email per file.** If the same email appears on several sites, it is credited to the site that owns it: the first site whose domain is the email's domain (`sales@bydcastlehill.com.au` goes to `bydcastlehill.com.au`, even when a dealer-group page earlier in the list shows it too). Otherwise it goes to the first site where it was a real link or text rather than only in a script, and otherwise to the first site in input order.
- **Every email stays in its list's own CSV.** An email found on many sites (a regulator on privacy pages, a manufacturer's head office) is credited the same way as any other and kept in the main CSV; there is no separate shared file.
- Rows follow the input order of the websites.
- If an email appears on several pages, `link` is the first page it was seen on. A later page wins only if it ties the email to a person name.
- A `name` that starts with `=`, `+`, `-` or `@` is prefixed with `'`, so a hostile page title can't become a live formula in Excel or Google Sheets.

### Unique emails across files

Each file is unique on its own, but the same email often appears in several files when the input lists overlap (an `-additions` list repeats sites of its base list, for example). `--unique` combines existing outputs into one list with every email once. It scrapes nothing and leaves the per-file CSVs alone. The list stays inside the category's folder:

```bash
npm run scrape -- --unique                                     # one list per category -> results/emails/<category>/unique/<category>.csv
npm run scrape -- --unique websites/car-dealers-au/*.au.csv    # only those files      -> results/emails/car-dealers-au/unique/all.csv
```

With no arguments, each category folder in `results/emails/` gets its own combined list, so categories are never mixed. With files, the name is the prefix the input names all share before their first `.`, `_` or `-` (`au.x.csv`, `au.y.csv` → `au`), or `all` when they share none (the car-dealer brand lists combine into `all.csv`). If the files you name belong to different categories, the combined list goes to `results/emails/unique/<name>.csv` instead, the only output outside a category folder. Columns are the same `name,email,website,link`. When an email is in several files, the row from the first file (sorted by category, then name) is kept. A summary (files, rows read, duplicates removed, most-overlapping files) is appended to `results/<category>/logs/unique.<name>.log`.

### Filtering emails by domain ending

`--include-suffix` and `--exclude-suffix` write an extra CSV that holds only the emails whose domain ends the way you ask. They filter the **outputs**, never the scrape: every email is still collected and cached, and the normal CSV always keeps the full list. Choose another filter later and nothing needs to be crawled again.

```bash
npm run scrape -- --include-suffix=.com,.net,.au          # only emails ending .com, .net or .au (incl. .com.au)
npm run scrape -- --exclude-suffix=.gov,.edu,.de          # everything except those endings
npm run scrape -- '--exclude-suffix[.gov,.edu,.de]'       # the same, bracket form (quote it: shells treat [..] as a pattern)
npm run scrape -- --include-suffix=.au --exclude-suffix=.gov.au   # .au emails, but not .gov.au
```

- **Matching.** A suffix matches a domain that ends with it at a dot: `.au` matches `x.com.au` and `x.gov.au` but not `x.nau`; `.com` matches `x.com` and not `x.com.au`; `.gov` matches `x.gov` and not `x.gov.au` (write `.gov.au` for that). Case and the leading dot don't matter, an empty entry (`[.com,.net,]`) is ignored, and repeating a flag adds to the list. Domains are checked as written in the email, so `info@x.com` is a `.com` email whatever country its business is in.
- **Both flags together:** an email is kept if it matches an include suffix (when any are given) and no exclude suffix.
- **It works with every command.** The filter is applied after the scrape, from the stored results, so it combines with any run. A list that needs scraping is scraped first (with every email), then filtered. A list that already has an output isn't scraped again; only its filtered CSV is written from its cache (`--summary-only` rebuilds the normal CSV too). With `--unique` the filter applies to the combined list. `--dry-run` says which filtered file would be written.
- **Where the files go.** Named after the filter, so different filters never overwrite each other (suffixes are sorted and joined with `-`, include and exclude with `_`):

```
results/emails/car-dealers-au/ford.au.csv                                     the full list, unchanged
results/emails/car-dealers-au/filtered/ford.au.include-suffix-au-com-net.csv  --include-suffix=.com,.net,.au
results/emails/car-dealers-au/filtered/ford.au.exclude-suffix-de-edu-gov.csv  --exclude-suffix=.gov,.edu,.de
results/emails/car-dealers-au/unique/car-dealers-au.csv                       --unique, the full combined list
results/emails/car-dealers-au/unique/car-dealers-au.exclude-suffix-de-edu-gov.csv    --unique with the filter
```

  The filtered files are never read by `--unique`. Columns are the usual `name,email,website,link`. Each filter run records a summary in the run history (`filter.end` / `unique.end` in `results/db/run-history.jsonl`) with how many emails were kept and which endings were dropped.
- There is no country filter: to keep or drop a country, list its ending, e.g. `--include-suffix=.au,.nz`.

## Command reference

| Command | What it does |
|---|---|
| `npm run scrape` | Scrape every list in `websites/` (and its category folders) that has no output in `results/` yet |
| `npm run scrape -- websites/car-dealers-au/toyota.au.csv [more.csv …]` | Scrape specific files, like a plain run: lists with an output are skipped, interrupted ones resume. Add `--force` to scrape them again |
| `npm run scrape -- --force` | Re-scrape all files in `websites/` from scratch |
| `npm run scrape -- --new-only [websites/car-dealers-au/toyota.au.csv]` | For a list that was already scraped and then got more websites: keep the stored results and crawl only the sites not in it, then rebuild the CSV and log from all of them. Without a file it covers every list under `websites/`. Not combinable with `--force` or `--summary-only` |
| `npm run scrape -- --retry-failed` | Crawl again, from the start, only the sites that failed with no emails (unreachable, timeout, …). Everything else comes from the stored results. Rebuilds the CSVs and logs. See [Retrying and continuing sites](#retrying-and-continuing-sites) |
| `npm run scrape -- --retry-rate-limited` | Fetch again only the pages a server refused with HTTP 429/503 (and the new links on them), and merge what they give into each site's result |
| `npm run scrape -- --retry-budget-queued` | Continue the sites that ran out of time budget from where they stopped: only the pages still queued are fetched, with the per-site budget of `--budget` |
| `npm run scrape -- --retry-capped --max-pages=N` | Continue the sites that reached the page cap from their saved queue, up to the higher cap `N` (the summary's `Capped` line) |
| `npm run scrape -- --summary-only` | Scrape nothing. Rebuild the CSVs and summaries from the stored results, applying the current email and name rules. Skips (and leaves untouched) a file with no cache or an interrupted scrape |
| `npm run scrape -- --summary-only --include-interrupted [file …]` | Same, but also for lists whose scrape never finished, from the sites stored so far. Check the `N of M stored` count first with `--dry-run`: a list with most of its sites still to scrape gives a partial CSV. The list stays marked unfinished, so the next scrape still resumes it |
| `npm run scrape -- --summary-only --check-mx` | Same, and drop emails whose domain can't receive mail (no MX or address record in DNS). `--check-mx` works with any scrape too |
| `npm run scrape -- --dry-run` | Show what a command would do with each file (scrape, resume, retry, skip), plus leftover markers and locks. Scrapes and writes nothing under `results/` |
| `npm run scrape -- --help` | List every option |
| `npm run scrape -- --unique` | Scrape nothing. Combine each category's outputs into `results/emails/<category>/unique/<category>.csv` with each email once. See [Unique emails across files](#unique-emails-across-files) |
| `npm run scrape -- --unique websites/car-dealers-au/*.au.csv` | Same, for only the named files: writes `results/emails/car-dealers-au/unique/all.csv` |
| `npm run scrape -- --include-suffix=.com,.au` / `--exclude-suffix=.gov,.edu` | Also write a CSV with only the emails whose domain ends with (or, for exclude, doesn't end with) those suffixes, in `emails/filtered/`. Works with any command, never changes the cache or the normal CSV. See [Filtering emails by domain ending](#filtering-emails-by-domain-ending) |
| `npm run scrape -- --unique --exclude-suffix=.gov` | The combined list, plus the filtered one in `emails/unique/` (`car-dealers-au.exclude-suffix-gov.csv`) |
| `npm run scrape -- --budget=MIN` | Soft time budget per site in minutes (default 20). When it runs out the site stops, keeps what it found and saves the pages still queued for `--retry-budget-queued`; a continued run gets its budget from here too. See [Crawl options](#crawl-options-depth-and-limits) |
| `npm run scrape -- --max-pages=N` | Cap the plain-HTTP page requests per site (`0` = unlimited, the default). A site that reaches the cap with pages still queued saves them for `--retry-capped` |
| `npm run scrape -- --browser-pages=N` | Cap the headless-browser requests per site (60; `0` turns the browser fallback off) |
| `npm run scrape -- --max-depth=N` | Cap the click levels followed from the start page (`0` = unlimited, the default) |
| `npm run scrape -- --concurrency=N --page-concurrency=N --host-concurrency=N` | Websites crawled in parallel (12), page requests within one site (3), requests to one server across all sites (3) |
| `npm run scrape -- --revalidate[=DAYS]` | Ask again about stored pages older than `DAYS` days (30); with no number, about every stored page once this run |
| `npm run scrape -- --ignore-robot-disallow` | Crawl pages robots.txt Disallows anyway. A robots.txt that answers 5xx still keeps the site out, and the Crawl-delay still applies. With `--retry-failed`, also re-crawls the sites an earlier run recorded as `robots-disallowed`. See [Politeness and robots.txt](#politeness-and-robotstxt) |
| `npm run scrape -- --quick` | Lighter, faster crawl (150 pages, 10 min per site). See [Crawl options](#crawl-options-depth-and-limits) |
| `npm run scrape -- --log-level=debug` | Also write every failed request, timeout and robots decision to the root `logs/`. See [Diagnostic logs](#diagnostic-logs) |
| `npm run typecheck` | Type-check the project with `tsc --noEmit` |
| `npm test` | Run the test suite (`node:test`, no network needed) |

The `--` after `npm run scrape` is required. It passes everything after it to the scraper.

Flags and file arguments can be combined in any order:

```bash
npm run scrape -- websites/a.csv --retry-failed --retry-rate-limited --retry-budget-queued --budget=60
```

```bash
npm run scrape -- websites/a.csv websites/b.csv --max-pages=600 --budget=30
```

Unknown flags stop the run with an error, so a typo doesn't silently run with the defaults. So do `--force=false`-style values on on/off flags, and fractions where a count is expected (`--concurrency=2.5`).

Progress is printed one line per site:

```
=== healthcare-nz/dentists.nz: 142 sites (0 stored) ===
[37/142] lumino.co.nz — 3 emails, 150 pages (101s)
[38/142] advanced-ceramics.co.nz — 0 emails, 2 pages, browser (33s)
[39/142] adhb.health.nz — 0 emails, 0 pages, robots-disallowed (10s)
```

The first line of every run shows the crawl options in use:

```
Crawl options: unlimited pages, 60 browser pages, depth unlimited, 20 min/site, 12 sites in parallel, stored pages revalidated after 30 days
```

## Crawl options (depth and limits)

**Deep crawl is the default.** Each website is crawled with no limit on pages or depth, until it runs out of links or its time budget (20 minutes).

**What "depth" (level) means:** depth is how many clicks a page is from the page the crawl started on:

```
level 0   dealer.com.au/                              ← start (landing) page
level 1   ├── /contact   /our-team   /used-cars       ← linked from the start page
level 2   │     └── /our-team/sales   /used-cars?page=2
level 3   │           └── /used-cars/2019-ford-ranger-12345
```

Pages listed in the site's `sitemap.xml` count as level 1.

There is **no depth limit by default**. The crawler follows links as deep as the time budget allows. Depth only affects the order pages are visited in: shallower pages go first, and contact, about, team and department pages (sales, parts, service, finance, fleet, bookings, …) go before everything else. Listing detail pages go last, because they almost never contain an email and big sites have thousands of them. Examples are car stock (`/used-cars/<car>`, `/stock/<id>`, `/new-vehicles/<model>`), offers, news, blog and event posts.

| Option | What it controls | Default (deep) | With `--quick` |
|---|---|---|---|
| `--max-pages=N` | Max page requests per site with plain HTTP (phase 1). `0` = unlimited. With a cap, a site that reaches it with pages still queued saves the queue, so `--retry-capped` can go deeper later | 0 (unlimited) | 150 |
| `--browser-pages=N` | Max page requests per site in the headless-browser fallback (phase 2). `0` turns the fallback off | 60 | 30 |
| `--max-depth=N` | Max click level to follow from the start page. `0` = unlimited | 0 (unlimited) | 0 (unlimited) |
| `--budget=MIN` | Soft time budget per site in minutes. When it runs out, the site stops, keeps what it found and saves the pages it still had queued, so `--retry-budget-queued` can continue it later. A hard stop happens 4 minutes later, and it also keeps (and saves) what was found | 20 | 10 |
| `--concurrency=N` | Websites crawled in parallel | 12 | 12 |
| `--page-concurrency=N` | Parallel page requests within one site (HTTP phase) | 3 | 3 |
| `--host-concurrency=N` | Parallel requests to one server, across all sites | 3 | 3 |
| `--revalidate[=DAYS]` | Pages already scraped in the category (see [Pages are scraped once](#pages-are-scraped-once-per-category)) are asked about again when older than `DAYS` days. With no number, every stored page is asked about once in this run | 30 days | 30 days |
| `--ignore-robot-disallow` | Crawl pages robots.txt Disallows anyway. A robots.txt that answers 5xx still keeps the site out (`robots-unavailable`), and the `Crawl-delay` is still honoured. With `--retry-failed`, the sites an earlier run recorded as `robots-disallowed` are crawled again too (a re-crawled site keeps its earlier row; only new emails are added) | not set (robots.txt respected) | not set |
| `--quick` | Preset: the lighter limits above (this was the default before deep crawl) | — | — |

Numbers can be written as `--max-pages=600` or `--max-pages 600`. An explicit option always overrides the preset. For example, `--quick --max-pages=250` uses the quick limits but 250 pages.

When to change them:
- **Default (deep):** best for most lists, especially large sites such as car dealers, dealer groups, tourism operators and hospitals.
- **`--quick`:** small business sites such as clinics and dentists, when you want results faster.
- **`--budget=40`:** very large sites where emails are buried deep, such as big directories or council sites (there is no page cap by default; add `--max-pages=N` to set one).
- **`--max-depth=2`:** only the start page, the pages it links to, and the pages those link to. Useful for a fast, shallow sweep of a huge list.
- **`--concurrency=6`:** a slow or unstable connection, or many sites on the same server.
- **`--concurrency=24 --page-concurrency=4 --host-concurrency=4`:** a faster run on a good connection. Total requests in flight are at most `concurrency × page-concurrency`, and no single server gets more than `host-concurrency`. Raise the per-server number slowly: servers that see too many requests rate-limit or block.

### Recommended settings

Measured against this repo's stored results (2.2 M pages, ~197 k emails): about 98% of emails sit 4 clicks deep or shallower, and 99.99% of all fetched pages are within 7. Beyond depth 7 the crawler only walks product and blog catalogues (the deepest pages found are 12 levels down) and finds essentially nothing. These presets use that.

**Large-site lists (car dealers, chains, directories) — the all-round recommendation:**

```bash
npm run scrape -- websites/<category>/<file>.csv --concurrency=10 --page-concurrency=3 --host-concurrency=3 --budget=60 --max-pages=2000 --max-depth=7
```

- `--max-depth=7` keeps everything the data says matters while cutting the bottomless catalogues that had one chain site crawl ~26,000 pages for no new emails.
- `--max-pages=2000` stops any single runaway site; its queue is saved, and `--retry-capped --max-pages=N` can go deeper later if wanted.
- `--budget=60` gives big sites a full hour. Small sites still finish on their own long before that.
- `--page-concurrency=3 --host-concurrency=3` is the polite sweet spot: 3 requests within a site, and never more than 3 to one server even when many listed domains redirect to the same host.
- `--concurrency=10` keeps ten sites moving at once — about 30 requests in flight in total, well within what a home connection handles.

**Fast first pass over small business sites (clinics, dentists, shops):**

```bash
npm run scrape -- websites/<category>/<file>.csv --quick --max-depth=4
```

`--quick` (150 pages, 10 min per site) with depth 4 already covers ~98% of the emails small sites yield.

**After any run — finish the leftovers** (stored results are reused, nothing already fetched is requested again):

```bash
npm run scrape -- --retry-failed --retry-rate-limited --retry-budget-queued --budget=60
```

As with any setting, start here and check the first file's summary: high `unreachable`, `Limited` or `timeout` counts mean the connection or the servers need gentler numbers (see [Is a high concurrency setting safe?](#is-a-high-concurrency-setting-safe)).

### Pages are scraped once

Every page the scraper fetches is kept in `results/db/pages.jsonl`, shared by all the lists of **all categories** and by later runs, together with who fetched it (category, list, site, run). When any site reaches a page again, with the same emails and links it gave before, the page is **not requested again**: sites of one group domain, several domains redirecting to one server, a list that grew (`--new-only`), another category that lists the same business, or a re-run. Pages are told apart by URL (without tracking and session parameters, `www.`, a trailing slash or a `#fragment`) and by how they were fetched (plain HTTP, or the browser, which sees what HTTP can't, so the two never stand in for each other). A 404 is remembered too. The store has an index file (`pages.idx`), so opening it does not read the pages and finding one takes two reads, however many are stored.

Reused pages count toward `--max-pages`, so a site gives the same result as it would without the store; only the requests are saved. The summary shows `N pages fetched + M reused`.

**Revalidation.** A stored page older than 30 days (change it with `--revalidate=DAYS`) is asked about again the next time a crawl reaches it. If the server gave an `ETag` or `Last-Modified`, the request is conditional, and a `304 Not Modified` keeps the stored copy without downloading the page. `--revalidate` with no number asks again about every stored page, once in the run, and so does scraping a list again from scratch (`--force`, or naming a file that already has an output). If the server sent new content (200) the new version replaces the stored one; on a 304 the stored record is kept and only its `fetchedAt` time becomes today's. The file is never deleted (see [the database](#the-database-and-resuming) for `npm run db:upgrade`). Only one scraping run at a time can use the page store (`results/db/locks/pages.lock`); a second run stops with the usual "in use by another run" error.

### Is a high concurrency setting safe?

The most aggressive setting you might use is `--concurrency=24 --page-concurrency=4 --host-concurrency=4`. It is safe for your data and your machine, but it is more aggressive than most runs need. It is not recommended as a first run.

**What can't go wrong**
- Nothing is lost if it overloads. Each finished site is saved to the database, `--retry-failed` redoes the failures, and `--retry-rate-limited` / `--retry-budget-queued` fetch the pages that were refused or ran out of time.
- Memory stays bounded. Browser pages are capped at 4 at once, whatever the other numbers are.
- It respects `robots.txt`, and 4 requests at a time to one server is gentle for any single host.

**What can go wrong**
- The peak is `concurrency × page-concurrency`, which is 24 × 4 = 96 requests in flight at once. Home routers, VPNs and Wi-Fi often struggle past roughly 50–100. That shows up as spurious `unreachable` or `timeout` failures and slower crawls.
- The per-server cap counts hostnames, not shared platforms. Hundreds of dealer sites run on the same platforms and CDNs, so those providers can still see a burst. Some rate-limit or block it, and blocked sites then look like "no emails found".
- Heavily loaded sites hit the per-site budget (`--budget`, 20 minutes by default) sooner and return partial results, so you can get fewer emails until you continue them with `--retry-budget-queued`.

**Recommended approach:** start with a moderate setting and watch the first file's failure counts in its summary (printed at the end of the file, and kept in `results/db/run-history.jsonl`). Raise the numbers only if the failures stay low.

```bash
npm run scrape -- --concurrency=16 --page-concurrency=3 --host-concurrency=3
```

If failures are high, lower the numbers, or run `--retry-failed` (and `--retry-rate-limited`) afterwards.

Examples:

```bash
npm run scrape -- websites/car-dealers-au/toyota.au.csv
```

```bash
npm run scrape -- websites/healthcare-nz/dentists.nz.csv --quick
```

```bash
npm run scrape -- websites/big.csv --max-pages=800 --budget=40
```

```bash
npm run scrape -- websites/huge.csv --max-depth=2 --concurrency=16
```

The options used are also written into each summary (in `results/db/run-history.jsonl`), so you can see how every run was configured.

## Running long jobs

Rough timings for 150 websites: about 30–60 minutes with `--quick`, and about 1–2 hours with the default deep crawl. Run long jobs in the background so they survive closing the terminal:

```bash
mkdir -p logs && nohup npm run scrape -- websites/car-dealers-au/toyota.au.csv > logs/run.log 2>&1 &
```

```bash
echo $!
```

`$!` prints the PID of the job you just started. Follow progress (Ctrl+C stops watching, not the scrape):

```bash
tail -f logs/run.log
```

Check whether it is still running (replace `12345` with the PID):

```bash
kill -0 12345 && echo running || echo finished
```

Stop it (the database keeps every site that already finished). `$!` is the PID of `npm`, and npm does not pass the signal on to the scraper, so stop the scraper process itself. Its PID is printed in the first line of the log: `Run 6696978c started (pid 23456)`.

```bash
kill 23456
```

The scraper logs `SIGTERM received, shutting down`, closes the headless browser and exits. Stopping only the `npm` PID leaves the scraper running in the background.

**Resume** after a stop, crash or reboot: run the same command again, or a plain `npm run scrape`. Sites already stored for the list in `results/db/sites.jsonl` are skipped. This also works for an interrupted re-scrape (`--force` or an explicit file). Two runs can't work on the same file at once: the second one skips it with an error (see [Cache and resuming](#cache-and-resuming)).

After a run finishes:
- `results/emails/<category>/<name>.csv` holds the results.
- The summary is in `results/db/run-history.jsonl` (the `list.end` event of the run) and printed at the end: websites with emails, failures by reason, unique emails, and name breakdown.
- Emails are unique within each file. For one list without repeats across files, run `npm run scrape -- --unique websites/car-dealers-au/*.au.csv` (writes `results/emails/car-dealers-au/unique/all.csv`).
- `logs/error-<date>.log` lists every error from the run with its stack trace. If it's empty, nothing went wrong internally. See [Diagnostic logs](#diagnostic-logs).
- If many sites failed with `unreachable` or `timeout` (often network hiccups), run `npm run scrape -- websites/<name>.csv --retry-failed`.
- If the summary has a `Limited` or `Out of time` line, run `--retry-rate-limited` or `--retry-budget-queued`. See [Retrying and continuing sites](#retrying-and-continuing-sites).
- Every scrape run first starts the headless browser once and installs Playwright's Chromium itself if it is missing (`ensureBrowser()`; skipped with `--summary-only`, `--dry-run`, `--unique` and `--browser-pages=0`). If failures still read `browserType.launch: Executable doesn't exist …`, install it by hand with the command below, then rerun with `--retry-failed`:

  ```bash
  npx playwright install chromium
  ```

## Retrying and continuing sites

A finished run can leave four kinds of unfinished work. Each has its own flag, and they can be combined in one run. Only the selected sites are crawled; every other site comes from the sache, and the CSV and summary are rebuilt from all of them.

| Flag | Which sites | What it does |
|---|---|---|
| `--retry-failed` | Failed with no emails (`unreachable`, `timeout`, `browser-error`, `internal-error`) — and the `robots-disallowed` sites too, when the run also has `--ignore-robot-disallow` | Crawls them again from the start |
| `--retry-rate-limited` | A server refused some pages with HTTP 429/503 even after one retry (the summary's `Limited` line) | Fetches only those pages, plus any new links found on them. Pages already fetched are not fetched again |
| `--retry-budget-queued` | Ran out of time budget with pages still queued (the summary's `Out of time` line), or before the headless-browser phase could run | Continues the saved queue with the `--budget` budget per site, then runs the browser phase if it is still owed. Pages already fetched are not fetched again |
| `--retry-capped --max-pages=N` | Reached the page cap (`--max-pages`) with pages still queued (the summary's `Capped` line) | Continues the saved queue up to the new cap `N`, which must be higher than the one they stopped at. Pages already fetched are not fetched again |

```bash
npm run scrape -- websites/churches-au/churches.au.csv --retry-budget-queued --budget=60
```

```bash
npm run scrape -- websites/gifts-au/*.csv --retry-failed --retry-rate-limited --retry-budget-queued --budget=40
```

- **Nothing is lost.** New emails are merged into the site's earlier ones. A site still unfinished after a retry (it ran out of time again, or was refused again) saves what is left, so the same command continues it further. Parts you didn't ask for are kept for later: `--retry-rate-limited` leaves a site's time-budget queue alone, and the other way round.
- **The budget.** The per-site time budget of a continued run comes from `--budget` (`--retry-budget-queued --budget=60`); the retry flag itself takes no value. Sites with a `Crawl-delay` need it: at 10 seconds per page, 20 minutes is only about 120 pages.
- **The page cap still counts.** A continued site can use the rest of its `--max-pages` (a cap only exists when you gave one; there is none by default). If the first crawl already used it up, the queue is kept and the log says so; raise `--max-pages` (`--max-pages=0` removes the cap) to continue.
- **Up to 2000 queued pages are saved per site,** best first. Pages past that can still be found again through links.
- **Without a file argument** the retries go through every list under `websites/` that has an output. A list never scraped is skipped (there is nothing to retry); scrape it normally first.
- **A re-crawl never loses emails.** A site crawled again from the start (by `--retry-failed`, or a row without saved state) keeps its earlier row as it was, and only emails the re-crawl found that the row didn't have are added.

**Sites scraped before this feature** have no saved queue, so `--retry-budget-queued` can't see them. `scripts/mark-budget-from-logs.ts` finds them in `logs/scraper-*.log` (the `time budget used up` lines) and marks their cache rows. A marked site is crawled again from the start with the new budget; its earlier row is kept and only new emails are added, and the mark is replaced by the re-crawl's own saved state. The same goes for rate-limited sites from older runs, which only have a count of skipped pages.

```bash
npx tsx scripts/mark-budget-from-logs.ts
```

```bash
npx tsx scripts/mark-budget-from-logs.ts --write
```

The first command only shows what it would mark. `--write` appends the marked rows to the database (the last row of a site wins; nothing is rewritten or deleted). A row is only marked if its page count still matches the log line, so a site scraped again since is left alone, and a file that a run is working on (or that has an interrupted scrape) is skipped.

## Running the Australian lists

The categories ending in `-au` hold Australian lists (`car-dealers-au`, `political-au`, `auto-repair-au`, `churches-au`, `gifts-au`, `martial-arts-au`, `entertainments-au`, `pizza-au`). The biggest is `websites/car-dealers-au/`, which lists car dealers by brand. Each file holds a brand's official AU site, its dealers (own domains, or dealer pages on group sites) and related brand businesses:

| File | Contents |
|---|---|
| `bmw.au.csv`, `byd.au.csv`, `chery.au.csv`, `ford.au.csv`, `geely.au.csv`, `gm.au.csv`, `gwm.au.csv`, `hyundai.au.csv`, `isuzu.au.csv`, `kia.au.csv`, `mazda.au.csv`, `mg.au.csv`, `mini.au.csv`, `nissan.au.csv`, `omoda-jaecoo.au.csv`, `skoda.au.csv`, `subaru.au.csv`, `suzuki.au.csv`, `toyota.au.csv`, `zeekr.au.csv` | One car brand each |

Run all of them in the background with the default deep crawl. Each file is processed in turn and gets its own output and log:

```bash
mkdir -p logs && nohup npm run scrape -- websites/car-dealers-au/*.au.csv > logs/au-run.log 2>&1 &
```

Or run one list at a time:

```bash
npm run scrape -- websites/car-dealers-au/toyota.au.csv
```

Afterwards, retry the sites that failed and continue the ones that were rate-limited or ran out of time. Everything else is kept:

```bash
npm run scrape -- websites/car-dealers-au/*.au.csv --retry-failed --retry-rate-limited --retry-budget-queued --budget=40
```

Rebuild the CSVs and summaries from the stored results without touching the network:

```bash
npm run scrape -- websites/car-dealers-au/*.au.csv --summary-only
```

Combine all dealer outputs into one list with each email once (`results/emails/car-dealers-au/unique/all.csv`; the brand names share no prefix), see [Unique emails across files](#unique-emails-across-files):

```bash
npm run scrape -- --unique websites/car-dealers-au/*.au.csv
```

Exclude a country's endings from the combined list, e.g. keep everything except German domains:

```bash
npm run scrape -- --unique websites/car-dealers-au/*.au.csv --exclude-suffix=.de
```

Note that `npm run scrape -- websites/car-dealers-au/*.au.csv` treats the files named like a plain run: a list with an output is skipped and an interrupted one resumes; add `--force` to scrape a finished list again. A plain `npm run scrape` would also pick up any list in `websites/` that has no output yet. Dealer sites are big, so expect roughly 1–2 hours per 150 sites with the default deep crawl. For a faster first pass, add `--quick`.

## Run summaries

After each CSV is processed, a summary is printed and **recorded** in `results/db/run-history.jsonl` as the `text` of a `list.end` event (next to its counts, mode and duration), so the file keeps a history of every run. Filtered and unique runs add `filter.end` and `unique.end` events the same way. Read them with, for example, `jq -r 'select(.t=="list.end" and .list=="dentists.nz") | .text' results/db/run-history.jsonl`.

```
[2026-09-29 13:49:30] veterinarians.nz.csv  (scrape, took 38m 12s)
  Websites : 72 total | 53 with emails | 14 no emails found | 5 failed
  Emails   : 241 unique (51 person name, 0 department page title, 30 business + mailbox, 100 input name, 40 business name, 20 email domain)
  Crawl    : 3919 pages fetched | headless browser used on 17 sites
  Failures : unreachable=5 (dns=3, http-403=2)
  Out of time: 2 site(s) ran out of time budget with 317 page(s) still queued: vetent.co.nz (176), carevets.co.nz (141); continue them with --retry-budget-queued (per-site budget: --budget=MIN)
  Capped   : 1 site(s) reached the page cap with 220 page(s) still queued: vetent.co.nz (220); continue them with --retry-capped --max-pages=N (a higher cap)
  Top sites: vetent.co.nz (25), myfarmfirst.co.nz (24), carevets.co.nz (23), ...
  Failed sites:
    - clivevets.co.nz [unreachable: dns]
  No emails found on:
    - anexa.co.nz
```

Failure reasons:

| Reason | Meaning |
|---|---|
| `unreachable` | The site didn't respond on any start URL. The summary says why, from the first start URL: `dns` (the domain doesn't resolve; the browser isn't tried either), `refused`, `tls`, `timeout`, `reset`, `private` (it resolves to a private address), `redirects`, `http-<status>` (e.g. `http-403`, often a bot block), or `not-html` |
| `robots-disallowed` | The site's `robots.txt` (on the host reached after redirects) forbids crawling it. No retry touches these by default; with `--ignore-robot-disallow` (and `--retry-failed`) they are crawled anyway |
| `robots-unavailable` | The site's `robots.txt` answers with a server error (5xx), which the robots.txt standard treats as "keep out". This may be temporary, so `--retry-failed` tries these again |
| `timeout` | The site exceeded the hard safety limit (the `--budget` plus 4 minutes; 24 minutes by default). It was stopped, and whatever it found by then is kept |
| `browser-error` | The headless browser crashed or couldn't start on this site. Plain-HTTP results, if any, are kept. The details are in `logs/error-<date>.log` |
| `internal-error` | The scraper itself crashed on this site. The stack trace is in `logs/error-<date>.log` |
| `other` | (Summary counts only) an older stored row whose failure was recorded as raw error text. The text is listed under "Failed sites" |

"No emails found" means the site was crawled successfully but publishes no email address. Often it only has a contact form.

A `Limited : N page(s) skipped on M site(s) …` line means those servers answered HTTP 429 (Too Many Requests) or 503 (Service Unavailable) even after one retry, so those pages were skipped. The busiest servers are listed. A few is normal. The scraper already slows down for a server that answers 429/503 (see [Politeness and robots.txt](#politeness-and-robotstxt)), so `--retry-rate-limited` is usually enough: it fetches just the skipped pages again. If the line stays large, run it with fewer parallel requests (`--host-concurrency=1`, or `--concurrency=6`). The per-site progress line also shows `N pages rate-limited`.

A `Capped : N site(s) …` line means those sites reached `--max-pages` with pages still queued. Contact-like pages are fetched first, so what's left is mostly deep pages; `--retry-capped --max-pages=N` continues them if you want more.

An `MX check : …` line (with `--check-mx`) lists the emails dropped because their domain can't receive mail.

An `Out of time: N site(s) …` line means those sites used up their time budget with pages still queued (`browser` instead of a count means the headless-browser phase didn't get to run). The most-queued sites are listed. `--retry-budget-queued` continues them where they stopped (budget from `--budget`); see [Retrying and continuing sites](#retrying-and-continuing-sites). The per-site progress line also shows `N queued at time limit`, and a continued site shows `(resumed: +X emails, +Y pages)`.

## Diagnostic logs

Besides the per-file summaries, every run writes structured diagnostic logs with [pino](https://getpino.io) to the root `logs/` folder (git-ignored):

| File | Contents |
|---|---|
| `logs/scraper-YYYY-MM-DD.log` | Every event at or above the log level (default `info`): run start and options, each file, each finished site with its counts and timing, warnings, errors |
| `logs/error-YYYY-MM-DD.log` | Only `error` and `fatal` events, with full stack traces. Check this first after a run |

- **Format:** one JSON object per line. Every line has `time`, `level` (`20` debug, `30` info, `40` warn, `50` error, `60` fatal), `msg` and `runId`. That makes it easy to separate overlapping runs. Lines logged while a file or site is being processed also carry `file` and `site`.
- **Rotation and retention:** a new file is started for each day, named by the run's start date. Files older than 30 days are deleted at startup. Change the period with `LOG_RETENTION_DAYS=N`; `0` keeps them forever. Only `scraper-*.log` and `error-*.log` are ever deleted, so your own `logs/run.log` from `nohup` is safe.
- **Writes are synchronous,** so the last lines before a crash or `kill` are never lost.
- **The terminal** shows a readable version of `info` and above: the usual `[n/N] host — …` progress lines, with warnings and errors highlighted. `--log-level` only changes the file log; the terminal always shows `info` and above. Each terminal line about a site starts with `[host]` and ends with the URL involved, when the message doesn't already say them: `[aolimo.com.au] request failed — https://aolimo.com.au/contact`.

### Log levels

`--log-level=<level>` (or the `LOG_LEVEL` environment variable; the flag wins) sets what goes into `scraper-*.log`. The levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `silent`.

| Level | What is logged |
|---|---|
| `info` (default) | Run/file/site progress, robots.txt blocks, sites that ran out of time budget (with the number of pages still queued) |
| `warn` | Sites that failed with no emails; the first page each server refused with 429/503 after a retry (the rest are counted in the summary); a server dropping a connection mid-response (once per site); hard timeouts; skipped input rows; unreadable cache lines; SIGINT/SIGTERM |
| `error` | The headless browser failing on a site or failing to start, a site crashing the scraper, a file skipped because another run holds it |
| `fatal` | Uncaught exceptions and unhandled rejections; the process exits with code 1 |
| `debug` | Every non-200 response, every rate-limited page after the first per server, network error (with its `ECONNRESET`/`ENOTFOUND` code), request timeout, oversize page, failed browser page, sitemap failure, refused private address and skipped off-site redirect. Verbose: use it to investigate a specific site |

### Reading the logs

```bash
npx pino-pretty < logs/scraper-2026-10-03.log
```

```bash
jq -c 'select(.level >= 40) | {time, site, msg, err: .err.message}' logs/scraper-2026-10-03.log
```

```bash
jq -c 'select(.site == "https://example.co.nz/")' logs/scraper-2026-10-03.log
```

## The database and resuming

Everything the scraper remembers is in `results/db/` (record layouts: [docs/db-schema.md](docs/db-schema.md)). The files are JSON lines (the newest record wins; only the scraper itself ever changes written data), shaped like tables so they can move to SQLite later:

| File | Meaning |
|---|---|
| `pages.jsonl` | Every page ever fetched, for all categories: emails, title, links, validators, when, and who fetched it (see [Pages are scraped once](#pages-are-scraped-once)). Never rotated or deleted; a 304 revalidation renews a record's `fetchedAt` in place |
| `pages.idx` | Hash index over `pages.jsonl` so it opens instantly. Derived: if deleted it is rebuilt from the pages (slow, once) |
| `sites.jsonl` | One row per finished site of a list (category, list, generation, run, and the result: the site URL, final URL after redirects, business name, emails with names and where each was found, pages fetched, whether the browser was used, any error with its detail, and what is left to retry) |
| `sites.idx` | Snapshot of where each current row is. Derived |
| `run-history.jsonl` | Run and list start/end events with each summary |
| `manifest.json` | Schema version and the ledger of what was imported from the old layout |
| `locks/pages.lock` | Holds the PID of the run using the page store; **one scraping run at a time**. A second run stops with an error. A lock left by a process that no longer exists is taken over automatically |
| `locks/<category>.<list>.lock` | The PID of the run working on that list |

Output and database files hold personal data, so new ones are created readable by their owner only (folders `0700`, files `0600`).

- **Interrupted runs resume automatically,** including interrupted `--force` re-scrapes. A list whose latest start has no end in the run history is interrupted: run the same command again (or a plain `npm run scrape`) and the sites already stored are skipped.
- **A fresh re-scrape keeps the old results.** When a file with an existing output is scraped again (`--force`), it starts a new *generation* of the list's rows; the earlier generation stays in `sites.jsonl`, ignored.
- **Outputs always use the current rules.** The CSV and summary re-apply the current email checks and name rules to every stored row, so after an update `--summary-only` cleans old outputs without re-scraping. Stored rows are never rewritten; a `--retry-*` run appends new rows (a site it will crawl again from scratch gets a `drop` row first, so an interrupted retry still redoes it), and rows it continues or re-crawls are kept until the retry's row supersedes them, so an interrupted retry loses nothing.
- **Field names.** Records now use readable names (`pages.jsonl`: `version, pageKey, mode, fetchedAt, page`). Records written before 2026-11-07 used one-letter names (`v, k, m, a, d`) and are still read. `npm run db:upgrade` (`-- --dry-run` counts only) rewrites the files once into the readable names and drops page records a newer copy replaced; run it with no scrape running and keep a copy of `results/db/` first. The first run afterwards rebuilds `pages.idx` (slow once).
- **Coming from the old layout** (`results/<category>/.cache`, `logs`, `emails`)? The first scrape imports it by itself, once; `npm run db:migrate` does the same on demand (`-- --dry-run` lists what it would import) and `npm run db:verify` checks that everything arrived. The old folders are only read, never changed or deleted by the import: remove them yourself once `db:verify` is happy (they were removed on this machine on 2026-11-07). Interrupted scrapes of the old layout resume where they stopped.

## How it works

### 1. Crawl each website (plain HTTP first)

- Fetches the start URL and follows redirects. The host it lands on becomes the site. `www.` is ignored when comparing hosts.
- If `https://` fails, it tries `http://` and then the `www.` version (or the bare domain for a `www.` input). Domains that don't resolve are not retried.
- Uses a priority queue. Pages with paths like `contact`, `about`, `team`, `staff`, `locations`, `clinic`, … are fetched first, then the rest breadth-first.
- Seeds the queue from `sitemap.xml` (and sitemaps listed in `robots.txt`).
- Skips non-HTML files (PDFs, images, documents, media), `wp-content/uploads`, login/cart/calendar pages, and crawl traps (URLs with many query parameters, very long URLs, very deep paths). Non-HTML responses are recognised by their `Content-Type` and never downloaded.
- Follows redirects itself, checking each hop against the `robots.txt` of its own host before requesting it. A page that redirects to another site, or into a disallowed path, is skipped. Gzipped sitemaps are supported, and sitemap URLs with `&amp;` are decoded.
- Follows `<frame>` and `<iframe>` sources on the same site, and `<meta http-equiv="refresh">` redirects, so older framed sites are crawled too.
- Decodes pages in their declared charset (header or `<meta charset>`), so names on older `windows-1252` sites come out right.
- Listing detail pages (car stock, offers, news and blog posts) are fetched last, and stock/product sitemaps are read after page sitemaps.
- Limits (defaults, see [Crawl options](#crawl-options-depth-and-limits)): **no page cap** (and unlimited depth), 3 parallel requests per site, 15 s per request, 5 MB per page, and a 20-minute budget per site (partial results are kept, and the pages still queued are saved for `--retry-budget-queued`).

### 2. Headless browser fallback

Chromium (via Playwright) re-crawls up to **60 pages** (`--browser-pages`), starting from the page Phase 1 landed on, when:
- the plain HTTP crawl couldn't load the site at all,
- the homepage looks JavaScript-rendered (very little text without scripts), or
- the HTTP crawl found no emails.

Images, fonts and media are blocked to keep it fast. Same-site frames are read along with the page. If Chromium crashes, the next page starts a new one. A domain that doesn't resolve at all isn't tried in the browser.

**Headless browser sandbox.** Chromium runs with its sandbox on, because it executes JavaScript from thousands of unknown sites. On Linux that needs unprivileged user namespaces. If the browser fails to start with a sandbox or namespace error (some hardened Ubuntu setups), either allow them for Playwright's Chromium (on Ubuntu 23.10+ that means an AppArmor profile for the Chromium binary), run the scraper in a container, or, accepting the risk, run with `SCRAPER_NO_SANDBOX=1`.

### 3. Extract emails from every page

- `mailto:` links, including several addresses in one link and `?subject=` parameters
- Plain text and HTML-entity-encoded addresses (`&#97;&#x6b;…`)
- Cloudflare email protection (`data-cfemail`, `/cdn-cgi/l/email-protection#…`)
- Obfuscated forms: `name [at] domain [dot] co [dot] nz`, `name(at)domain.com`, and ROT13-scrambled addresses (`vasb@rknzcyr.pbz.nh` → `info@example.com.au`)
- `data-email` / `data-mail` attributes and schema.org / JSON-LD `email` fields

Junk is filtered out: image names like `logo@2x.png`, placeholders (`you@example.com`, `your@email.com`, `jane.smith@test.com.au`, `you@company.com.au`), platform and service addresses (Sentry, Wix, Squarespace, Podium form relays, domain-parking pages), hash-like local parts, local parts with `..` or a dot at either end, and domains that aren't under a real public suffix (checked against the Public Suffix List with `tldts`, so `.travel` or `.auto` pass and `.ay` doesn't). Text glued on after an address (`info@acme.co.nzPhone`) is cut off at the capital letter.

### 4. Pick a name

1. **Person name:** from a schema.org `Person` (JSON-LD or microdata; the name goes only to that Person's own addresses, an `email` array included, never to the other emails on the page), from `mailto:` link text, or from a nearby heading in the same "card". It must match the email by whole words: a name word equals a part of the local part (a role word such as `president` doesn't count), or the local part is a usual form like `jsmith`, `janes` or `smithj` for `Jane Smith`, or the name has a title such as `Dr` and the address is neither a role mailbox (`bishop@`, `vicar.general@`) nor another person's first name. Names made only of department words (`Customer Care`) never count. One page name on several addresses of a site stays only on those that match it. As a last resort a name comes from the local part itself, only when its first part is a known given name (`src/data/given-names.txt`) and nothing is a department, role or place word: `mary.jones@` → Mary Jones, `paul.wu@`, `rachel.b@`, `johnh@` → John H, `alex@` → Alex (not when the word is the email's own domain, `preston@prestonmazda.com.au`). When one first part appears with five or more different second parts on one site (`bec.brisbane@`, `bec.cairns@`, …), those are branch mailboxes, not people. Generic mailboxes (`info@`, `reception@`, `admin@`, …) never get a person name.
2. **Department page title:** the `<h1>` of a sub-page, used only in [section-focused crawls](#section-focused-crawling). Generic titles such as "Contact Us" or "About" don't count.
3. **Input name:** the input CSV's own name for the site, when it has a name column.
4. **Business name:** from JSON-LD `Organization`/`LocalBusiness`, then `og:site_name`, then the cleaned `<title>`, then the domain. "Home", "Welcome" and similar are skipped, "Welcome to " is dropped from the front, and an address after a comma is cut off.

### How names are chosen

The four sources above are the ingredients; which one a row gets depends on the email's domain. Each email is classified by its domain: **own** (the site's registrable domain; the landing page's too, unless it is on an unrelated domain such as `change.org` for `bestbitepizza.com.au`, which the summary lists under `Redirects`), **free mail** (`src/data/free-mail-domains.txt`) or **another company's**. Then, the first that applies:

| Email | Name |
|---|---|
| A person is found (above) | the person |
| Own, branch/place/department mailbox (`geebung@`, `customer.relations@`) or a role (`marketing@`, `customerservice@`) | `Business - Mailbox` (`Acme Electrical - Geebung`, `Anytime Fitness - Marketing`). The business comes first: it is the reliable part and keeps one organisation's rows together |
| Own, bare or junk mailbox (`info@`, `admin@`, `office@`, `0zbi@`: names no function) | the department page title on a section sub-page (at most 3 emails on that page), else the business: the input's name column, else the scraped business name (outside a section the input points at: the scraped one) |
| Free mail on the site's home/contact/about/team pages, or a site with at most 2 free-mail addresses | like an own address |
| Other free mail | the mailbox tidied (`debcopeland88@gmail.com` → Debcopeland), or the domain (`qq.com`) for a junk or role mailbox |
| Another company's | the list's own site for that domain, else a site of that domain scraped for any list (its business name), else the domain's first label as words (`anytimefitness.in` → Anytime Fitness, `clmnz.co.nz` → CLMNZ); a mailbox or role is appended. A domain with the same first label as the site's (`smashtennis.co.nz` on `smashtennis.nz`) is the site's own |

The scraped business name comes from the landing page: JSON-LD organisation, `og:site_name`, `application-name`, the `<title>` segment matching the domain, the logo image's alt text, the footer's `© Name`, then another title segment, then the host. Bot-check, error and parked page titles (`Just a moment...`), URLs and phone numbers are never a name. Words that make a mailbox a role or office rather than a person are in `src/data/role-words.txt` (with `DEPT_WORDS` in `extract.ts`); places that are also given names in `src/data/place-words.txt`. Run-together words (`anytimefitness`, `customerservice@`, `lynfieldfitness@`) are cut into words with `src/data/name-words.txt`, and `julieweller@` / `jsmith@` are read as Julie Weller / J Smith with `surnames.txt`. Where each list comes from, with licences: `src/data/SOURCES.md`; `npx tsx scripts/build-word-lists.ts --from <downloads>` rebuilds them.

### Section-focused crawling

If the landing page has a real path, the crawl focuses on that section. This happens when the input URL has a path, when a redirect goes to another domain with a path, or when the path is two or more segments deep. For example, `adhb.health.nz` redirects to `healthnz.govt.nz/hospitals-services/hospitals/auckland/central`.

Pages under that path are fetched first, sitemap seeds are limited to that path, and emails on its sub-pages are named after the page title. Single-segment same-domain redirects like `/home` or `/en` are treated as the whole site.

### Politeness and robots.txt

- **`robots.txt` is respected** for every page by the rules of that page's own host and protocol: the original domain, the host reached after a redirect, and the site's `www.`/bare-domain and `http:`/`https:` variants, each with its own `robots.txt`. Every redirect hop is checked before it is requested, and the browser fallback follows the same rules. If the landing page is disallowed, the site is reported as `robots-disallowed` and nothing is extracted. A `robots.txt` that answers with a server error (5xx, after one retry) counts as "disallow everything" and is reported as `robots-unavailable`. `--ignore-robot-disallow` relaxes this for one run: the `Disallow` rules are ignored, while a 5xx robots.txt and the `Crawl-delay` (next point) still apply.
- **`Crawl-delay` is honoured** (capped at 10 seconds), as a minimum gap between requests to that server, by plain HTTP and the headless browser alike.
- At most **3 requests at a time to any one server** across all sites being crawled, in both phases. This matters when many input domains redirect to the same server.
- HTTP 429/503 responses and transient network errors are retried once, after the server's `Retry-After` (1–30 s) or 3 seconds. A page still refused is skipped and counted (see `Limited` in [Summary logs](#summary-logs)).
- **A server that rate-limits is slowed down automatically.** Each 429/503 doubles the gap between requests to that server (1 s, 2 s, 4 s … up to 10 s), for every site hosted there, and each normal answer halves it again.
- **Only public addresses are fetched.** Redirects (and, in the browser, any request, including popups and WebSockets) to localhost, private networks or cloud metadata addresses are refused. Plain-HTTP connections go to exactly the addresses that were checked, so a host can't answer differently on a second DNS lookup. Service workers are blocked in the browser.

## Tuning

Most limits are command-line options; see [Crawl options](#crawl-options-depth-and-limits). Their defaults are `DEFAULT_OPTIONS` and `QUICK_OPTIONS` in `src/crawler.ts`. The remaining constants are at the top of the source files:

| Constant | File | Default | Meaning |
|---|---|---|---|
| `DEFAULT_OPTIONS` / `QUICK_OPTIONS` | `src/crawler.ts` | unlimited/60/unlimited/20 min · 150/30/unlimited/10 min | Pages, browser pages, max depth, soft budget |
| `HARD_TIMEOUT_EXTRA_MS` | `src/index.ts` | 4 min | Hard safety timeout per site = budget + this |
| `STOP_GRACE_MS` | `src/index.ts` | 30 s | After the hard timeout, how long a site gets to return its partial results |
| `HTTP_TIMEOUT` | `src/http.ts` | 15 s | Per-request timeout |
| `MAX_BYTES` | `src/http.ts` | 5 MB | Max page size |

The heuristics are in `src/extract.ts` (junk filters, generic mailbox names, words that are never part of a person's name (`DEPT_WORDS`), the person rules) and `src/output.ts` (which name each row gets), with word lists in `src/data/` (`given-names.txt`, `surnames.txt`, `places.txt`, `name-words.txt`, `role-words.txt`, `place-words.txt`, `free-mail-domains.txt`; sources in `SOURCES.md`).

After changing them, check the effect on everything scraped so far (reads the database, writes nothing):

```bash
npx tsx scripts/recheck-cache.ts
```

To find given names missing from the list, review the first parts of `first.last@` addresses that aren't in it:

```bash
npx tsx scripts/given-names-report.ts 2
```

Link priority keywords (`PRIORITY_PATH`), the listing-page penalty (`LISTING_SEGMENT`) and skip rules are in `src/urls.ts`.

## Limitations

- Emails that appear only as images, or behind contact forms, logins or CAPTCHAs, can't be extracted.
- A site is limited by its 20-minute budget (and by `--max-pages` if you set one), so emails on deep pages can be missed on very large sites. Contact-like pages are fetched first and listing pages last to reduce this, and `--retry-budget-queued` / `--retry-capped` can continue them later.
- The browser follows redirects inside Chromium, so a redirect hop there is checked against `robots.txt` only after it loads (its page is then discarded).
- Sites whose `robots.txt` forbids generic crawlers are skipped by design.
- Name detection is heuristic. When it isn't confident, it falls back to the business name (or the email's domain) rather than guessing. People whose first name isn't in the given-name list only get a person name when the page itself ties the name to the email.
- Aggregator and government sites often list emails belonging to other organisations. Those rows are credited to the site they were found on, unless another input site owns the email's domain. A dealer group's email shown on several dealer sites in the list is credited to the first of them when none of those sites is on the group's domain.

## Responsible use

These are publicly published business contact details. If you use them for marketing, anti-spam law applies. In New Zealand that is the **Unsolicited Electronic Messages Act 2007**, and in Australia the **Spam Act 2003**. Both require consent and a working unsubscribe option. Respect each site's terms of use.

## Project layout

```
src/
  index.ts      CLI entry: argument handling, file selection, --dry-run
  run.ts        Per-file run: hard timeouts, retries, CSV outputs, summaries, --unique
  cli.ts        Command-line parsing, validation and --help text
  input.ts      Reading the website column of an input CSV
  cache.ts      Which stored results each --retry-* flag redoes
  db/           The database: pages-repo (fetched pages, reuse, revalidation), hash-index, sites-repo, runs-repo, open (Db), lock, migrate (old layout import)
  output.ts     CSV rows (crediting each email to its site), formula-safe cells, re-checking stored results
  filter.ts     --include-suffix / --exclude-suffix: which emails a filtered CSV keeps, and its file name
  mx.ts         --check-mx: whether an email's domain can receive mail
  abort.ts      Waits that give up when a site's time is up
  logger.ts     pino logger: console + logs/*.log JSON files, per-site context, crash/signal handlers
  crawler.ts    Per-site crawl: page queue, HTTP phase, headless-browser phase
  http.ts       HTTP GET: redirects, per-server limits, Crawl-delay, retries, charset decoding
  browser.ts    Shared sandboxed Chromium and the browser page fetcher
  robots.ts     robots.txt loading and checks
  sitemap.ts    Sitemap seeding (including .xml.gz)
  netguard.ts   Refuses private, loopback and metadata addresses; the DNS lookup HTTP connections use
  extract.ts    Email extraction, junk filtering, person/business name detection
  urls.ts       URL normalisation, crawlability rules, link priority, section detection
  data/         word lists (given-names, surnames, places, name-words, role-words, place-words, free-mail-domains) + SOURCES.md
test/           node:test suites and a local test server (npm test)
scripts/        recheck-cache.ts, given-names-report.ts, build-word-lists.ts, mark-budget-from-logs.ts, db-migrate.ts, db-verify.ts
websites/       Input CSVs, in category folders: websites/<category>/*.csv (git-ignored)
results/        db/ (the database) and emails/<category>/ (the output CSVs, plus filtered/ and unique/) (git-ignored)
logs/           Diagnostic JSON logs: scraper-<date>.log, error-<date>.log (git-ignored)
```

For internals, see [ARCHITECTURE.md](ARCHITECTURE.md).
