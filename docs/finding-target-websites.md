# Finding target websites for any sector and country

The scraper needs a CSV of business websites (`name,website`). This is the playbook for building that CSV for **any
sector** (cafes, dentists, tyre shops, gyms, ...) in **any country**, with the fewest steps and tokens. Rules for the
files themselves (names, numbering, what counts as a site) are in [AGENTS.md](../AGENTS.md) "Building website lists".

## Pick the source (in this order)

| # | Source | Script | Yield | Cost / limits |
|---|---|---|---|---|
| 1 | **Overture Maps** (public parquet on S3) | `scripts/overture-places.py` | Bulk: thousands per country, most with a website | Free. ~8-15 min per country per query, needs `pip3 install --user duckdb` |
| 2 | **OpenStreetMap**: Overpass API | `scripts/fetch-osm-places.ts` | Fewer sites, good local coverage | Free; public servers time out or refuse (retry later, it resumes) |
| 2b | OpenStreetMap: Geofabrik extract | `scripts/pbf-places.py` | Same data as 2, no Overpass needed | Download a `.pbf`, needs `pip install osmium` |
| 3 | **Web search** by name + suburb for places with no website | [finding-websites-by-web-search.md](finding-websites-by-web-search.md) | ~15 % of searches give a site | Token-expensive, 200 searches per turn. Last resort for gaps |
| 4 | Google Places API | none yet | Best coverage | Needs an API key from the owner |

Not used: paid data sets, and scraping Yellow Pages, Yelp or TripAdvisor (terms).

## The procedure

Work in a scratch folder (`/tmp/cand`), never in `websites/` until the last step.

1. **Describe the sector** with a few words and regexes: a category regex for Overture (`tire`, `dentist`,
   `cafe|coffee`), and OSM tags for Overpass (find them on https://taginfo.openstreetmap.org: `shop=tyres`, `amenity=dentist`).
2. **Find the right Overture categories** (one query, prints category names with counts and how many have a website):
   ```bash
   python3 scripts/overture-places.py NZ --list-categories=tire
   ```
   Use the names it prints in `--category`. Related categories are matched by regex, so `tire` covers `tire_shop` and
   `tire_dealer_and_repair`. Skip categories that are only near the sector (`retirement_home` also contains "tire").
3. **Pull candidates**. One pull per country can take several categories at once; the output has a `category`
   column, so one broad pull can be split into several lists afterwards:
   ```bash
   python3 scripts/overture-places.py AU /tmp/cand/tyres.au.csv --category='tire'
   python3 scripts/overture-places.py CA /tmp/cand/dentists.ca.csv --category='dentist' --bbox=-141,41.6,-52,83.2
   python3 scripts/overture-places.py AU /tmp/cand/pizza.au.csv --name='pizz' --category='pizza'   # label or name fits
   ```
   Add OpenStreetMap candidates for the gaps (optional; `--match` selectors are described at the top of the script):
   ```bash
   npx tsx scripts/fetch-osm-places.ts au /tmp/cand/tyres-osm.au.csv --match='shop=tyres'
   npx tsx scripts/fetch-osm-places.ts ca /tmp/cand/dentists-osm.ca.csv --match='amenity=dentist' --bbox=41.6,-141,83.2,-52
   ```
   `au` and `nz` have built-in areas; for another country pass any label plus `--bbox` (OSM wants south,west,north,east;
   Overture wants west,south,east,north).
4. **Merge** several candidate files into one (header once); duplicates are removed by the next step:
   ```bash
   head -n 1 /tmp/cand/a.csv > /tmp/cand/all.csv; tail -n +2 -q /tmp/cand/a.csv /tmp/cand/b.csv >> /tmp/cand/all.csv
   ```
5. **Make the list**. Dry run first; it drops invalid URLs, ordering/social/directory/`.edu` sites, duplicates and
   everything already in the category folder, and picks the file name (`tyre-shops-2.au.csv`, ...):
   ```bash
   npx tsx scripts/new-list.ts tyre-shops-au tyre-shops au /tmp/cand/all.csv --dry-run --only-country
   npx tsx scripts/new-list.ts tyre-shops-au tyre-shops au /tmp/cand/all.csv --only-country   # --append for later batches
   ```
   `--only-country` also drops sites whose domain belongs to another country (`.co.uk`, `.jp`, `.com.au` in an NZ list);
   generic domains (`.com`, `.net`, `.shop`, `.coffee`, ...) and the target country's own (`.com.au`) are kept.
   Chain rows (one domain, many store pages) are better in their own list:
   `python3 scripts/split-chains.py websites/tyre-shops-au websites/tyre-shops-au/tyre-shops-2.au.csv tyre-chains au`.
6. **Validate** any list or whole category (duplicates inside a file and across files, platforms, invalid URLs). Dry run by default;
   `--write` only rewrites files that are not committed yet:
   ```bash
   npx tsx scripts/validate-lists.ts websites/tyre-shops-au websites/tyre-shops-nz --only-country
   ```
   With `--only-country` the country of each file is the `<cc>` in its name (`.au.csv`); `--only-country=ca` forces one for all files.
7. **Spot-check** about 20 random rows (is it the sector? is it the business's own site?), drop what does not fit, and look
   at the category column for off-topic types before `new-list.ts` (`cut -d, -f3 file | sort | uniq -c | sort -rn`).
8. **Report** per country: new sites, duplicates dropped, total in the category against the owner's target, sources
   used, shortfall. Never pad with unrelated businesses or invent sites. If short, say which source is left
   (web search, Google Places key). Don't scrape emails until the owner asks.

## Conventions (short)

- Folder `websites/<topic>-<cc>/` (`tyre-shops-au`), file `<list>.<cc>.csv` (`<cc>` is any country code), header `name,website`.
- Existing files are never edited. New sites collect in one unscraped numbered file (`-2`) with `--append`; `-3` starts after `-2` is scraped.
- Duplicates are judged by host + path across the whole category folder, so the same business is never scraped twice.

## Pitfalls

- Overture returns each store of a chain separately: expect many rows on one domain (split them out, step 5). Their emails are the head office's.
- Overture has places with no website; they cannot be scraped. Counting only places with a website is the real yield.
- Overpass often answers `406`/`429`/timeouts; the fetcher resumes from `<out>.tiles.jsonl`, so just re-run it.
- `python3 -I` hides a `pip --user` install: run the Python scripts with plain `python3`.
- A category word can match the wrong sector (`tire` in `retirement`), so look at `--list-categories` before pulling.
- Domain country: `--only-country` keeps every generic ending and the target country's, and drops other 2-letter country endings. A few 2-letter endings are used as plain generic domains by local businesses (`.co .io .me .tv .ai .cc .ly .gd .to .fm .app`) and are kept; change `GENERIC_CC_TLDS` in `scripts/new-list.ts` to alter that. Australian chains' `.com.au` pages for NZ stores are dropped from NZ lists.
- Free-hosting pages (`wixsite.com`, `business.site`, `.my.canva.site`) are weak sites; keep them only if the owner wants everything.

## Batch log

| Date | Topic | Country | Files | Sources |
|---|---|---|---|---|
| 2026-11-03 | cafes, mechanics, tyre shops | AU, NZ | `cafes.<cc>`, `mechanics-2.<cc>`, `tyre-shops.<cc>` | OpenStreetMap |
| 2026-11-05 | same | AU, NZ | numbered `-2` files and `*-chains` lists (counts in TODO.md "Open items") | Overture Maps (release 2026-10-21.0): one broad pull per country with `--category='cafe|coffee|tire|automotive|...'`, then split by the `category` column |
