# The database (`results/db/`)

Everything the scraper remembers lives in one folder. It is JSON lines today, shaped like tables so it can move to SQLite without changing the code that uses it: `Db` (`src/db/open.ts`) hands out three repositories, `PagesRepo`, `SitesRepo` and `RunsRepo`, and only those know about files.

```
results/
  db/
    pages.jsonl         every page ever visited                         -> table  pages
    pages.idx           hash index over pages.jsonl (derived)           -> the primary key of pages
    sites.jsonl         each list's per-site results                    -> table  sites
    sites.idx           snapshot of where each current row is (derived)
    run-history.jsonl   run and list events, summaries                  -> tables runs, list_runs, outputs
    manifest.json       schema version, ledger of imports
    locks/              pages.lock, <category>.<list>.lock (PID files)
  emails/<category>/<list>.csv, filtered/…, unique/…                    outputs, rebuilt from the database
```

Rules for everything in `db/`:

- **Newest record wins.** Records are appended, one per line; for the same page, site or list the newest one counts and older ones are history. Only the scraper's own code ever changes a file that is already written, in two ways, and an agent or a person never edits these files by hand:
  - a revalidated page that the server says is unchanged (304) gets its `fetchedAt` overwritten in place (see [Revalidation](#revalidation));
  - `npm run db:upgrade` rewrites a file once, into the current field names, and drops records that a newer one replaced. It writes a new file beside the old one and swaps it in only when it is complete.
- **One record per line**, `"version"` first, identifiers before the large body, so an index is built without parsing bodies. A line cut off by a crash fails to parse, is skipped, and the next writer starts on a fresh line.
- **Field names have two versions.** `version` 2 (current) uses the readable names below. `version` 1 (written until 2026-11-07) used one-letter names. Both are read; new records are always version 2, and `npm run db:upgrade` converts the old lines (see [Version 1 names](#version-1-names)).
- **Indexes are derived.** `pages.idx` and `sites.idx` may be deleted; the next open rebuilds them from the data (slow once, then incremental: only bytes written after the index are scanned).
- Files are created readable by their owner only (they hold personal data).

## pages.jsonl → `pages`

One fetched page. Primary key `(mode, pageKey)`; the record with the highest `fetchedAt` wins.

| field | meaning |
|---|---|
| `version` | schema version (2) |
| `pageKey` | page key: `pageKey(url)` (no scheme, no tracking params, no `www.`, no trailing slash) |
| `mode` | `http` (plain fetch) or `browser` (Chromium). Never stand in for each other |
| `fetchedAt` | when it was fetched or last revalidated (epoch ms, always 13 digits) |
| `host` | the key's host, for per-site queries |
| `cat`, `list`, `site`, `run` | who fetched this version: category, list, input website, run id. `cat` only (and `run: "legacy"`) for pages imported from the old layout |
| `page` | the page: `{url, emails[], title?, links[], at, etag?, lastModified?}`; absent on a known 404/410, which has `"gone":1` instead. When a record is read, `page.at` is set from `fetchedAt` of the line head |

SQLite later: `CREATE TABLE pages (mode, page_key, host, fetched_at, cat, list, site, run, gone, data JSON, PRIMARY KEY (mode, page_key))`, index on `host` and on `(cat, list)`. A page is fetched once for all categories.

### Revalidation

A stored page older than `--revalidate` days (default 30) is asked about again, with `If-None-Match` / `If-Modified-Since` when the server gave validators. There are two outcomes:

| server answer | what happens to the stored record |
|---|---|
| **200**, the page changed | The new content is appended as a new record and replaces the old one (the newest record wins). The old line is dead weight until `npm run db:upgrade` drops it. |
| **304 Not Modified** | The content is the same, so nothing is copied. The same record stays and only its `fetchedAt` is overwritten in place with today's time (the 13 digits keep the line's length, so no offset moves), and the index entry is updated. If the line is not as expected the record is appended again instead, as for a 200. |

`pages.idx` is an open-addressing hash table: 64-byte header (magic, version, slots, count, bytes of `pages.jsonl` covered) then 32-byte slots (hash, offset, at, length, flags). A lookup is two positional reads and checks the record's key, so a hash collision can't return the wrong page. It grows by rehashing into a new file and renaming.

## sites.jsonl → `sites`

The result of one site in one scrape of one list.

| field | meaning |
|---|---|
| `version` | schema version (2) |
| `type` | `site`, or `drop` (removes the site from the list's current generation, so it is scraped again) |
| `cat`, `list` | category and list (file name without `.csv`) |
| `generation` | a fresh re-scrape of a finished list opens the next one; older generations stay but are ignored |
| `run`, `writtenAt` | run id and write time (epoch ms) |
| `site` | the input website (the key within the list) |
| `result` | the `SiteResult` (`src/crawler.ts`), unchanged: emails, pages, `resume` state for the `--retry-*` flags, … |

Current rows of a list = the last row per `site` in the list's highest `generation`, minus drops. SQLite later: `sites (cat, list, gen, site, run, written_at, result JSON, dropped)`, primary key `(cat, list, gen, site)` keeping the latest.

## run-history.jsonl → `runs`, `list_runs`, `outputs`

Events (`type`), each with `version`, `at` (epoch ms), `ts` (ISO), `run`:

| `type` | fields |
|---|---|
| `run.start` | `pid`, `argv`, `options`, `node` |
| `run.end` | `durationMs`, `failedFiles` |
| `list.start` | `cat`, `list`, `generation`, `mode`, `sites`, `resumed`, `fresh` |
| `list.end` | `cat`, `list`, `generation`, `status`, `mode`, `durationMs`, `csv`, `counts`, `reasons`, `text` (the human summary) |
| `filter.end` | `cat`, `list`, `csv`, `emails`, `kept`, `text` |
| `unique.end` | `cat` (null across categories), `label`, `csv`, `files`, `rowsRead`, `uniqueEmails`, `text` |

**A list is interrupted when its latest `list.start` has no later `list.end`** (a run that died or hit an error never wrote it). The next plain run resumes it in the same generation. Entries imported from the old logs have `legacy: true` and the original text.

## Version 1 names

Lines written before 2026-11-07 use one-letter names. They are still read as they are; `npm run db:upgrade` renames them.

| file | version 1 → version 2 |
|---|---|
| `pages.jsonl` | `v`→`version`, `k`→`pageKey`, `m`→`mode`, `a`→`fetchedAt`, `d`→`page` |
| `sites.jsonl` | `v`→`version`, `t`→`type`, `g`→`generation`, `a`→`writtenAt`, `r`→`result` |
| `run-history.jsonl` | `v`→`version`, `t`→`type`, `a`→`at`, `g`→`generation` |

`npm run db:upgrade` (`-- --dry-run` only counts) needs no scrape running and about the size of `pages.jsonl` in free disk space. Per file it writes `<file>.upgrade`, then renames it over the original. `pages.jsonl` also loses the records a newer copy of the same page replaced and lines cut off by a crash; `sites.jsonl` and `run-history.jsonl` keep every row. The two `.idx` files are deleted because they pointed into the old files; the next run rebuilds them (slow once). A file that is already current is left alone. Keep a copy of `results/db/` first if the data matters: it is the only copy of what has been fetched.

## manifest.json

`{ schema, createdAt, migrations }`. `schema` is 2 once the files use the version 2 names. `migrations` is the ledger of files imported from the old per-category layout (`results/<category>/.cache`, `logs`, `emails`): one entry per source file with its size and counts. A source in the ledger is never imported again.

## Moving to SQLite

Implement the three repository classes over SQLite tables as above and have `Db` open them; the crawler (`PagesView`), `run.ts` and the scripts only use the repository methods. The JSONL files then become an import source, the way the old layout is one today (`src/db/migrate.ts`). SQLite also lifts the one-scrape-at-a-time limit (`locks/pages.lock`): its transactions serialise writers, so several runs can share one database.
