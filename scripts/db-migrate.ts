/**
 * Imports the old per-category layout (results/<category>/.cache, logs, emails) into results/db/ and
 * results/emails/. The old files are only read, never changed or deleted. Safe to repeat or resume: what is
 * already imported is skipped. A scrape does the same automatically before its first run.
 *
 *   npm run db:migrate              # import
 *   npm run db:migrate -- --dry-run # list what would be imported; writes nothing
 *
 * Then check the result with `npm run db:verify`.
 */
import { Db } from '../src/db/open.js';
import { migrate } from '../src/db/migrate.js';
import { initFileLogging } from '../src/logger.js';
import { OUT_DIR } from '../src/paths.js';

initFileLogging('info');
const dryRun = process.argv.includes('--dry-run');
const db = new Db(OUT_DIR, { readOnly: dryRun });
try {
  const r = migrate(db, { dryRun });
  if (!r.sources) console.log('Nothing to import: every file of the old layout is already in the database.');
  else if (dryRun) console.log(`\n${r.sources} file(s) would be imported. Run without --dry-run to do it.`);
  else console.log(`\nImported ${r.done} file(s): ${r.pages.imported} pages (${r.pages.skipped} already had a copy as new, ${r.pages.bad} unreadable), ${r.rows} site rows, ${r.events} history entries, ${r.csvs.copied} CSVs copied${r.interrupted.length ? `; interrupted, will resume: ${r.interrupted.join(', ')}` : ''}.`);
} finally {
  db.close();
}
