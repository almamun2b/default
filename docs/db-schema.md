# The database (`results/db/`)

Everything the scraper remembers lives in one folder. It is JSON lines today, shaped like tables so it can move to SQLite without changing the code that uses it: `Db` (`src/db/open.ts`) hands out three repositories, `PagesRepo`, `SitesRepo` and `RunsRepo`, and only those know about files.

```
results/
  db/
    pages.jsonl         every page ever visited (append-only)           -> table  pages
    pages.idx           hash index over pages.jsonl (derived)           -> the primary key of pages
    sites.jsonl         each list's per-site results (append-only)      -> table  sites
    sites.idx           snapshot of where each current row is (derived)
    run-history.jsonl   run and list events, summaries                  -> tables runs, list_runs, outputs
    manifest.json       schema version, ledger of imports
    locks/              pages.lock, <category>.<list>.lock (PID files)
  emails/<category>/<list>.csv, filtered/…, unique/…                    outputs, rebuilt from the database
```

Rules for everything in `db/`:

- **Append-only.** Nothing is edited or deleted. The newest record wins; older ones stay as history.
- **One record per line**, `"v"` (schema version) first, identifiers before the large body, so an index is built without parsing bodies. A line cut off by a crash fails to parse, is skipped, and the next writer starts on a fresh line.
- **Indexes are derived.** `pages.idx` and `sites.idx` may be deleted; the next open rebuilds them from the data (slow once, then incremental: only bytes written after the index are scanned).
- Files are created readable by their owner only (they hold personal data).

## pages.jsonl → `pages`

One fetched page. Primary key `(m, k)`; the record with the highest `a` wins.

| field | meaning |
|---|---|
| `v` | schema version (1) |
| `k` | page key: `pageKey(url)` (no scheme, no tracking params, no `www.`, no trailing slash) |
| `m` | mode: `http` (plain fetch) or `browser` (Chromium). Never stand in for each other |
| `a` | when it was fetched or last revalidated (epoch ms) |
| `host` | the key's host, for per-site queries |
| `cat`, `list`, `site`, `run` | who fetched this version: category, list, input website, run id. `cat` only (and `run: "legacy"`) for pages imported from the old layout |
| `d` | the page: `{url, emails[], title?, links[], at, etag?, lastModified?}`; absent on a known 404/410, which has `"gone":1` instead |

SQLite later: `CREATE TABLE pages (mode, key, host, fetched_at, cat, list, site, run, gone, data JSON, PRIMARY KEY (mode, key))`, index on `host` and on `(cat, list)`. A page is fetched once for all categories; revalidation (`--revalidate`, default 30 days) appends a newer record.

`pages.idx` is an open-addressing hash table: 64-byte header (magic, version, slots, count, bytes of `pages.jsonl` covered) then 32-byte slots (hash, offset, at, length, flags). A lookup is two positional reads and checks the record's key, so a hash collision can't return the wrong page. It grows by rehashing into a new file and renaming.

## sites.jsonl → `sites`

The result of one site in one scrape of one list.

| field | meaning |
|---|---|
| `t` | `site`, or `drop` (removes the site from the list's current generation, so it is scraped again) |
| `cat`, `list` | category and list (file name without `.csv`) |
| `g` | generation: a fresh re-scrape of a finished list opens the next one; older generations stay but are ignored |
| `run`, `a` | run id and write time |
| `site` | the input website (the key within the list) |
| `r` | the `SiteResult` (`src/crawler.ts`), unchanged: emails, pages, `resume` state for the `--retry-*` flags, … |

Current rows of a list = the last row per `site` in the list's highest generation, minus drops. SQLite later: `sites (cat, list, gen, site, run, written_at, result JSON, dropped)`, primary key `(cat, list, gen, site)` keeping the latest.

## run-history.jsonl → `runs`, `list_runs`, `outputs`

Events (`t`), each with `v`, `a`, `ts` (ISO), `run`:

| `t` | fields |
|---|---|
| `run.start` | `pid`, `argv`, `options`, `node` |
| `run.end` | `durationMs`, `failedFiles` |
| `list.start` | `cat`, `list`, `g`, `mode`, `sites`, `resumed`, `fresh` |
| `list.end` | `cat`, `list`, `g`, `status`, `mode`, `durationMs`, `csv`, `counts`, `reasons`, `text` (the human summary) |
| `filter.end` | `cat`, `list`, `csv`, `emails`, `kept`, `text` |
| `unique.end` | `cat` (null across categories), `label`, `csv`, `files`, `rowsRead`, `uniqueEmails`, `text` |

**A list is interrupted when its latest `list.start` has no later `list.end`** (a run that died or hit an error never wrote it). The next plain run resumes it in the same generation. Entries imported from the old logs have `legacy: true` and the original text.

## manifest.json

`{ schema, createdAt, migrations }`. `migrations` is the ledger of files imported from the old per-category layout (`results/<category>/.cache`, `logs`, `emails`): one entry per source file with its size and counts. A source in the ledger is never imported again.

## Moving to SQLite

Implement the three repository classes over SQLite tables as above and have `Db` open them; the crawler (`PagesView`), `run.ts` and the scripts only use the repository methods. The JSONL files then become an import source, the way the old layout is one today (`src/db/migrate.ts`). SQLite also lifts the one-scrape-at-a-time limit (`locks/pages.lock`): its transactions serialise writers, so several runs can share one database.
