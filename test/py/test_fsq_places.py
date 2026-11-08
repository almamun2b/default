"""Manual check for scripts/fsq-places.py (CI is Node-only):  python3 test/py/test_fsq_places.py
Builds a tiny fake cache in a temp folder (needs: pip install duckdb); no network, no token."""
import csv
import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import duckdb

SPEC = importlib.util.spec_from_file_location('fsq', Path(__file__).resolve().parents[2] / 'scripts' / 'fsq-places.py')
fsq = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fsq)

# fsq_place_id, name, website, email, locality, labels, lat, lon
AU = [
    ('1', "Tony's Pizza", 'https://tonys.example.com.au', 'hi@tonys.example.com.au', 'Sydney',
     ['Dining and Drinking > Restaurant > Pizzeria'], -33.9, 151.2),
    ('2', 'Slice Bar', 'https://slice.example.com.au', None, 'Perth',
     ['Dining and Drinking > Restaurant > Pizzeria'], -31.9, 115.9),
    ('3', 'Pizza No Site', None, 'x@y.example.com', 'Sydney', ['Dining and Drinking > Restaurant > Pizzeria'], -33.8, 151.1),
    ('4', 'Pizzarella Gym', 'https://pg.example.com.au', None, 'Sydney', ['Sports > Gym'], -33.7, 151.0),
    ('5', 'Retirement Village', 'https://rv.example.com.au', None, 'Sydney', ['Community > Retirement Home'], -33.6, 151.0),
]


def build(root, release, cc, rows):
    d = Path(root) / f'dt={release}' / f'country={cc}'
    d.mkdir(parents=True)
    con = duckdb.connect()
    con.execute('CREATE TABLE t(fsq_place_id VARCHAR, name VARCHAR, website VARCHAR, email VARCHAR, locality VARCHAR,'
                ' fsq_category_labels VARCHAR[], latitude DOUBLE, longitude DOUBLE)')
    con.executemany('INSERT INTO t VALUES (?,?,?,?,?,?,?,?)', rows)
    con.execute(f"COPY t TO '{d / 'part.parquet'}' (FORMAT PARQUET)")


def run(root, *args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        fsq.main(['--cache-dir', str(root), *args])
    return out.getvalue()


def rows_of(path):
    with open(path, newline='') as f:
        return list(csv.DictReader(f))


class FsqPlaces(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'cache'
        build(self.root, '2026-01-01', 'AU', AU)
        self.out = Path(self.tmp.name) / 'out.csv'

    def tearDown(self):
        self.tmp.cleanup()

    def test_category_query_skips_places_without_website(self):
        run(self.root, 'query', 'au', str(self.out), '--category=pizzeria')
        self.assertEqual([r['name'] for r in rows_of(self.out)], ['Slice Bar', "Tony's Pizza"])

    def test_include_no_website_keeps_them_with_empty_website(self):
        run(self.root, 'query', 'AU', str(self.out), '--category=pizzeria', '--include-no-website')
        got = {r['name']: r['website'] for r in rows_of(self.out)}
        self.assertEqual(got['Pizza No Site'], '')
        self.assertEqual(len(got), 3)

    def test_category_or_name_fits(self):
        run(self.root, 'query', 'AU', str(self.out), '--category=pizzeria', '--name=pizz')
        self.assertIn('Pizzarella Gym', [r['name'] for r in rows_of(self.out)])

    def test_bbox_is_an_optional_sub_region(self):
        run(self.root, 'query', 'AU', str(self.out), '--category=pizzeria', '--bbox=112,-35,154,-33')
        self.assertEqual([r['name'] for r in rows_of(self.out)], ["Tony's Pizza"])

    def test_regex_with_quote_is_a_bound_parameter(self):
        run(self.root, 'query', 'AU', str(self.out), "--name=Tony's")
        self.assertEqual([r['name'] for r in rows_of(self.out)], ["Tony's Pizza"])

    def test_list_categories_counts_labels(self):
        text = run(self.root, 'list-categories', 'AU', 'pizzeria')
        self.assertIn('Dining and Drinking > Restaurant > Pizzeria\t3 places\t2 with website', text)

    def test_unknown_country_exits_with_extract_hint(self):
        with self.assertRaises(SystemExit) as c:
            run(self.root, 'query', 'CA', str(self.out), '--category=x')
        self.assertIn('extract CA', str(c.exception))

    def test_newest_local_release_wins_and_can_be_pinned(self):
        build(self.root, '2026-06-01', 'AU', AU[:1])
        run(self.root, 'query', 'AU', str(self.out), '--category=pizzeria')
        self.assertEqual(len(rows_of(self.out)), 1)
        run(self.root, 'query', 'AU', str(self.out), '--category=pizzeria', '--release=2026-01-01')
        self.assertEqual(len(rows_of(self.out)), 2)

    def test_query_needs_a_selector(self):
        with self.assertRaises(SystemExit):
            run(self.root, 'query', 'AU', str(self.out))

    def test_countries_validation(self):
        self.assertEqual(fsq.countries('au, nz'), ['AU', 'NZ'])
        with self.assertRaises(SystemExit):
            fsq.countries('AUS')

    def test_hf_token_from_env_file(self):
        import os
        from unittest import mock
        (Path(self.tmp.name) / '.env').write_text('# c\nexport HF_TOKEN="hf_abc"\n')
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(fsq, 'ROOT', Path(self.tmp.name)):
            os.environ.pop('HF_TOKEN', None)
            self.assertEqual(fsq.hf_token(), 'hf_abc')


if __name__ == '__main__':
    unittest.main()
