/**
 * Rewrites results/db/ in the current field names and drops dead records (see src/db/upgrade.ts). The old files
 * are replaced only when the new ones are complete. Run it with no scrape running, and keep a copy of
 * results/db/ first if the data is precious: it is the only copy of what the scraper has fetched.
 *
 *   npm run db:upgrade -- --dry-run   # count what would change; writes nothing
 *   npm run db:upgrade                # do it
 */
import { describeReport, upgradeDb } from '../src/db/upgrade.js';
import { LockedError } from '../src/db/lock.js';

const dryRun = process.argv.includes('--dry-run');
try {
  const reports = upgradeDb({ dryRun });
  if (!reports.length) console.log('There is no results/db/ here.');
  for (const r of reports) console.log(describeReport(r));
  if (!dryRun && reports.some((r) => r.upgraded)) console.log('\nDone. The first run afterwards rebuilds pages.idx (and sites.idx) from the new files; that is slow once.');
  else if (dryRun) console.log('\nDry run: nothing was changed. Run without --dry-run to do it.');
} catch (err) {
  if (err instanceof LockedError) {
    console.error(`${err.message}\nStop the running scrape first.`);
    process.exit(1);
  }
  throw err;
}
