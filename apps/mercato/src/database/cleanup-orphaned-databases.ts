import 'dotenv/config';
import pg from 'pg';

/**
 * Cleans up orphaned preview databases that don't have corresponding open PRs.
 * Accepts comma-separated list of open PR numbers via OPEN_PR_NUMBERS env var.
 *
 * Environment variables:
 * - DATABASE_ADMIN_URL: Admin database URL with postgres superuser
 * - OPEN_PR_NUMBERS: Comma-separated list of open PR numbers (e.g., "123,456,789")
 *
 * Usage: OPEN_PR_NUMBERS=123,456,789 tsx src/database/cleanup-orphaned-databases.ts
 */
async function cleanupOrphanedDatabases() {
  const openPrNumbersRaw = process.env.OPEN_PR_NUMBERS ?? '';
  const openPrNumbers = new Set(
    openPrNumbersRaw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0),
  );

  console.log('==========================================');
  console.log('Orphaned PR Database Cleanup');
  console.log('==========================================');
  const openPrList =
    openPrNumbers.size > 0 ? [...openPrNumbers].join(', ') : '(none)';
  console.log(`Open PRs: ${openPrList}`);
  console.log('');

  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error('DATABASE_ADMIN_URL is not set');
    process.exit(1);
  }

  const adminClient = new pg.Client({ connectionString: adminUrl });

  try {
    await adminClient.connect();

    const databasesResult = await adminClient.query(
      `SELECT datname FROM pg_database WHERE datname ~ '^open_mercato_pr_[0-9]+$' ORDER BY datname`,
    );

    const prDatabases = (
      databasesResult.rows as Array<{ datname: string }>
    ).map((row) => row.datname);

    const dbList = prDatabases.join(', ') || '(none)';
    console.log(`Found ${prDatabases.length} preview database(s): ${dbList}`);
    console.log('');

    let deletedCount = 0;
    for (const dbName of prDatabases) {
      const prNumber = dbName.replace('open_mercato_pr_', '');

      if (openPrNumbers.has(prNumber)) {
        console.log(`Skipping ${dbName} - PR #${prNumber} is still open`);
        continue;
      }

      console.log(`Dropping orphaned database: ${dbName}`);

      await adminClient.query(
        `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `,
        [dbName],
      );

      await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      console.log(`  ✓ Database '${dbName}' dropped`);

      deletedCount++;
    }

    console.log('');
    console.log('==========================================');
    console.log(
      `Cleanup complete. Dropped ${deletedCount} orphaned database(s).`,
    );
    console.log('==========================================');

    await adminClient.end();
    process.exit(0);
  } catch (error) {
    console.error('Error during orphaned database cleanup:');
    console.error(error);

    try {
      await adminClient.end();
    } catch {}

    process.exit(1);
  }
}

void cleanupOrphanedDatabases();
