"""Businesses of any sector in any country from the public Overture Maps places parquet (needs: pip install duckdb; run with plain
python3, not -I, which hides a --user install). About 10-15 min per country when a bbox is known (AU and NZ built in, others via --bbox).

  python3 scripts/overture-places.py <CC> <out.csv> --category=<regex> [--category=<regex> ...] [--name=<regex>]
                                     [--include-no-website] [--bbox=west,south,east,north] [--release=latest|2026-10-21.0]
  python3 scripts/overture-places.py <CC> --list-categories=<keyword> [--bbox=...]

--category   regex (case-insensitive) matched against taxonomy.primary and its hierarchy; a place fits if any --category or --name fits
--name       regex matched against the business name (e.g. 'pizz'); combine with --category for places labelled differently
--list-categories=<keyword>  print the taxonomy values that contain the keyword, with place counts, to choose --category values
--include-no-website  keep places without a website too (website column empty), e.g. as input for web search
Closed places are always dropped. Output columns: name,website,category,locality.

Examples:
  python3 scripts/overture-places.py AU --list-categories=tyre
  python3 scripts/overture-places.py AU /tmp/cand/tyres.au.csv --category='tire'
  python3 scripts/overture-places.py CA /tmp/cand/dentists.ca.csv --category='dentist' --bbox=-141,41.6,-52,83.2
"""
import re, sys, urllib.request
import duckdb

BBOX = {'AU': (112, -44, 154.5, -9), 'NZ': (166, -47.5, 179, -34)}  # west, south, east, north
args = sys.argv[1:]
flags = [a for a in args if a.startswith('--')]
pos = [a for a in args if not a.startswith('--')]
opt = lambda name: [f[len(name) + 1:] for f in flags if f.startswith(name + '=')]
if not pos or not (len(pos) == 2 or opt('--list-categories')) or '--help' in flags:
    sys.exit(__doc__)
cc = pos[0].upper()
out = pos[1] if len(pos) > 1 else None
bbox = tuple(float(v) for v in opt('--bbox')[0].split(',')) if opt('--bbox') else BBOX.get(cc)

release = (opt('--release') or ['latest'])[0]
if release == 'latest':
    xml = urllib.request.urlopen('https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/', timeout=30).read().decode()
    release = max(re.findall(r'<Prefix>release/([^/]+)/</Prefix>', xml))
print('Overture release', release, file=sys.stderr)

esc = lambda s: s.replace("'", "''")
where = [f"addresses[1].country = '{esc(cc)}'", "coalesce(operating_status, 'open') <> 'closed'"]
if bbox:
    where.append(f'bbox.xmin >= {bbox[0]} AND bbox.ymin >= {bbox[1]} AND bbox.xmax <= {bbox[2]} AND bbox.ymax <= {bbox[3]}')
else:
    print(f'no built-in bbox for {cc}: scanning the whole planet (slow); pass --bbox=west,south,east,north', file=sys.stderr)
cat_expr = "array_to_string(list_append(taxonomy.hierarchy, taxonomy.primary), '|')"

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET threads=4;")
src = f"read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*', hive_partitioning=1)"

if opt('--list-categories'):
    kw = esc(opt('--list-categories')[0])
    rows = con.execute(f"SELECT taxonomy.primary, count(*) AS places, count(websites[1]) AS with_website FROM {src} WHERE {' AND '.join(where)} AND {cat_expr} ILIKE '%{kw}%' GROUP BY 1 ORDER BY 2 DESC").fetchall()
    for r in rows:
        print(f'{r[0]}\t{r[1]} places\t{r[2]} with website')
    sys.exit()

fits = [f"regexp_matches({cat_expr}, '{esc(c)}', 'i')" for c in opt('--category')] + [f"regexp_matches(names.primary, '{esc(n)}', 'i')" for n in opt('--name')]
if not fits:
    sys.exit('give at least one --category or --name')
where.append('(' + ' OR '.join(fits) + ')')
if '--include-no-website' not in flags:
    where.append('websites[1] IS NOT NULL')
con.execute(f"""
COPY (
  SELECT names.primary AS name, websites[1] AS website, taxonomy.primary AS category, addresses[1].locality AS locality
  FROM {src}
  WHERE {' AND '.join(where)}
) TO '{esc(out)}' (FORMAT CSV, HEADER);
""")
print(con.execute(f"select category, count(*) from read_csv('{esc(out)}') group by 1 order by 2 desc limit 15").fetchall())
