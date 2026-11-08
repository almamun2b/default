"""Businesses of any sector in any country from Foursquare OS Places (free, Apache 2.0). Needs: pip install duckdb
(run with plain python3, not -I, which hides a --user install).

The dataset is gated on Hugging Face and its table is not sorted by country, so a remote query scans all of it
(20-40 min). So the script works in two steps:

  1. extract (once per release, needs HF_TOKEN): one remote scan copies the wanted countries into a local, git-ignored
     cache, data/fsq/dt=<release>/country=<CC>/. Several countries share one scan.
  2. list-categories / query (seconds, no token, no network): read only the local cache.

One-time setup: accept the dataset at https://huggingface.co/datasets/foursquare/fsq-os-places, create a read token at
https://huggingface.co/settings/tokens, and put HF_TOKEN=hf_... in the repo's git-ignored .env (or export it).

  python3 scripts/fsq-places.py extract AU,NZ [--release=latest|2026-10-15] [--refresh]
  python3 scripts/fsq-places.py list-categories <CC> <keyword> [--bbox=west,south,east,north] [--release=...]
  python3 scripts/fsq-places.py query <CC> <out.csv> --category=<regex> [--category=<regex> ...] [--name=<regex>]
                                      [--bbox=west,south,east,north] [--include-no-website] [--release=...]

--category   regex (case-insensitive) matched against the place's category labels joined with '|'; a place fits if any
             --category or --name fits
--name       regex matched against the business name (e.g. 'pizz'); combine with --category for places labelled differently
--bbox       optional sub-region of the country (point-in-box on latitude/longitude); there is no default box
--include-no-website  also keep places without a website (website column empty; the cache only holds such
                      places when they have an email - extract keeps a row only for website or email)
--refresh    extract again even if the country is already in the cache for that release

Closed places are dropped at extract time. Output columns of query: name,website,category,locality; a place without a
website is skipped unless --include-no-website, since the scraper needs one. The cache also keeps email, tel and the
Foursquare id for a later look (FSQ emails are not used by the scraper yet; see docs/finding-target-websites.md).
Foursquare is its own place database: stronger than OSM on consumer venues (food, shops), weaker on trades, and its US
coverage beats AU/NZ - sample a sector before trusting it.

Examples:
  python3 scripts/fsq-places.py extract AU,NZ
  python3 scripts/fsq-places.py list-categories AU pizza
  python3 scripts/fsq-places.py query AU /tmp/cand/fsq-pizza.au.csv --category='pizza'
"""
import argparse
import csv
import re
import shutil
import sys
import urllib.request
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'data' / 'fsq'
DATASET = 'foursquare/fsq-os-places'
KEEP = ('fsq_place_id, name, website, email, tel, fsq_category_ids, fsq_category_labels, locality, region, postcode,'
        ' latitude, longitude, date_created, date_refreshed')
CAT = "array_to_string(fsq_category_labels, '|')"
HAS_WEBSITE = "website IS NOT NULL AND length(trim(website)) > 0"
HAS_EMAIL = "email IS NOT NULL AND length(trim(email)) > 0"


def hf_token():
    """HF_TOKEN from the environment, else from the repo's git-ignored .env file."""
    import os
    token = os.environ.get('HF_TOKEN')
    env = ROOT / '.env'
    if not token and env.is_file():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith('export '):
                line = line[7:].strip()
            if line.startswith('HF_TOKEN='):
                token = line.split('=', 1)[1].strip().strip('"\'')
    return token or None


def countries(text):
    codes = [c.strip().upper() for c in text.split(',') if c.strip()]
    if not codes or not all(re.fullmatch(r'[A-Z]{2}', c) for c in codes):
        sys.exit(f'country must be a 2-letter code or a comma list of them, got {text!r}')
    return codes


def bbox_of(text):
    try:
        w, s, e, n = (float(v) for v in text.split(','))
    except ValueError:
        sys.exit('--bbox needs west,south,east,north as four numbers')
    return w, s, e, n


def remote_release(token, wanted):
    if wanted != 'latest':
        return wanted
    req = urllib.request.Request(f'https://huggingface.co/api/datasets/{DATASET}/tree/main/release?recursive=false',
                                 headers={'Authorization': f'Bearer {token}'})
    dates = re.findall(r'dt=([0-9-]+)', urllib.request.urlopen(req, timeout=60).read().decode())
    if not dates:
        sys.exit(f'could not list releases of {DATASET} (dataset accepted on Hugging Face? token valid?)')
    return max(dates)


def has_country(cache, release, cc):
    return any((cache / f'dt={release}' / f'country={cc}').glob('*.parquet'))


def local_release(cache, cc, wanted):
    """The pinned release, else the newest one in the cache that holds the country."""
    if wanted != 'latest':
        found = [wanted] if has_country(cache, wanted, cc) else []
    else:
        found = sorted(p.name[3:] for p in cache.glob('dt=*') if has_country(cache, p.name[3:], cc))[::-1]
    if not found:
        sys.exit(f'no local Foursquare data for {cc}: run  python3 scripts/fsq-places.py extract {cc}')
    return found[0]


def extract(a):
    token = hf_token()
    if not token:
        sys.exit("HF_TOKEN is not set: put HF_TOKEN=hf_... in the repo's git-ignored .env file or export it, after "
                 'accepting the dataset once on its Hugging Face page and creating a read token')
    if not re.fullmatch(r'[A-Za-z0-9_\-]+', token):
        sys.exit('HF_TOKEN has unexpected characters')
    wanted = countries(a.countries)
    release = remote_release(token, a.release)
    todo = [c for c in wanted if a.refresh or not has_country(a.cache_dir, release, c)]
    print('Foursquare OS Places release', release, file=sys.stderr)
    if not todo:
        print(f'{",".join(wanted)} already in {a.cache_dir}/dt={release} (use --refresh to extract again)')
        return
    tmp = a.cache_dir / f'.partial-dt={release}'
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    con = duckdb.connect()
    con.execute(f"CREATE SECRET (TYPE huggingface, TOKEN '{token}')")
    src = f'hf://datasets/{DATASET}/release/dt={release}/places/parquet/*.parquet'
    inlist = ', '.join(f"'{c}'" for c in todo)
    print(f'scanning the remote table for {",".join(todo)} (20-40 min)...', file=sys.stderr)
    con.execute(f"""
      COPY (SELECT {KEEP}, country FROM read_parquet('{src}')
            WHERE country IN ({inlist}) AND date_closed IS NULL AND (({HAS_WEBSITE}) OR ({HAS_EMAIL})))
      TO '{tmp}' (FORMAT PARQUET, PARTITION_BY (country), COMPRESSION zstd)""")
    dest = a.cache_dir / f'dt={release}'
    dest.mkdir(parents=True, exist_ok=True)
    for part in sorted(tmp.glob('country=*')):
        shutil.rmtree(dest / part.name, ignore_errors=True)
        shutil.move(str(part), str(dest / part.name))
    shutil.rmtree(tmp, ignore_errors=True)
    for cc in todo:
        if not has_country(a.cache_dir, release, cc):
            print(f'no places found for {cc}', file=sys.stderr)
            continue
        n, w, e = con.execute(
            f"SELECT count(*), count(*) FILTER (WHERE {HAS_WEBSITE}), count(*) FILTER (WHERE {HAS_EMAIL}) "
            "FROM read_parquet(?)", [str(dest / f'country={cc}' / '*.parquet')]).fetchone()
        print(f'{cc}: {n} places, {w} with a website, {e} with an email -> {dest / ("country=" + cc)}')


def scope(a):
    """(source glob, WHERE clauses, parameters) for list-categories and query."""
    release = local_release(a.cache_dir, a.country, a.release)
    glob = str(a.cache_dir / f'dt={release}' / f'country={a.country}' / '*.parquet')
    print('Foursquare OS Places release', release, '(local cache)', file=sys.stderr)
    where, params = [], []
    if a.bbox:
        w, s, e, n = bbox_of(a.bbox)
        where.append('longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?')
        params += [w, e, s, n]
    return glob, where, params


def list_categories(a):
    glob, where, params = scope(a)
    rows = duckdb.connect().execute(f"""
      SELECT label, count(*) AS places, count(*) FILTER (WHERE {HAS_WEBSITE}) AS with_website FROM (
        SELECT unnest(fsq_category_labels) AS label, website FROM read_parquet(?)
        {('WHERE ' + ' AND '.join(where)) if where else ''}
      ) WHERE label ILIKE ? GROUP BY 1 ORDER BY 2 DESC""", [glob, *params, f'%{a.keyword}%']).fetchall()
    for label, places, with_website in rows:
        print(f'{label}\t{places} places\t{with_website} with website')


def query(a):
    if not (a.category or a.name):
        sys.exit('give at least one --category or --name')
    glob, where, params = scope(a)
    fits = [f'regexp_matches({CAT}, ?, \'i\')' for _ in a.category] + ["regexp_matches(name, ?, 'i')" for _ in a.name]
    where.append('(' + ' OR '.join(fits) + ')')
    params += [*a.category, *a.name]
    if not a.include_no_website:
        where.append(HAS_WEBSITE)
    rows = duckdb.connect().execute(f"""
      SELECT name, coalesce(trim(website), '') AS website, fsq_category_labels[1] AS category, locality
      FROM read_parquet(?) WHERE {' AND '.join(where)} ORDER BY name, website""", [glob, *params]).fetchall()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['name', 'website', 'category', 'locality'])
        w.writerows(rows)
    by = {}
    for r in rows:
        by[r[2]] = by.get(r[2], 0) + 1
    print(f'{len(rows)} places -> {out}')
    print(sorted(by.items(), key=lambda kv: -kv[1])[:15])


def main(argv=None):
    p = argparse.ArgumentParser(prog='fsq-places.py', description=__doc__.split('\n\n')[0])
    p.add_argument('--cache-dir', type=Path, default=CACHE, help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('extract', help='copy countries from the remote table into the local cache (needs HF_TOKEN)')
    e.add_argument('countries', help='2-letter code or comma list, e.g. AU,NZ')
    e.add_argument('--release', default='latest')
    e.add_argument('--refresh', action='store_true')
    e.set_defaults(fn=extract)
    lc = sub.add_parser('list-categories', help='category labels containing a keyword, with counts (local cache)')
    lc.add_argument('country')
    lc.add_argument('keyword')
    lc.add_argument('--bbox')
    lc.add_argument('--release', default='latest')
    lc.set_defaults(fn=list_categories)
    q = sub.add_parser('query', help='write name,website,category,locality for matching places (local cache)')
    q.add_argument('country')
    q.add_argument('out')
    q.add_argument('--category', action='append', default=[])
    q.add_argument('--name', action='append', default=[])
    q.add_argument('--bbox')
    q.add_argument('--include-no-website', action='store_true')
    q.add_argument('--release', default='latest')
    q.set_defaults(fn=query)
    a = p.parse_args(argv)
    if hasattr(a, 'country'):
        a.country = countries(a.country)[0]
    a.fn(a)


if __name__ == '__main__':
    main()
