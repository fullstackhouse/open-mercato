import 'dotenv/config';
import pg from 'pg';

/**
 * Clones the main 'open_mercato' database to a preview database (e.g., open_mercato_pr_123).
 * Used for preview deployments to create isolated database environments.
 *
 * Uses PostgreSQL's CREATE DATABASE ... TEMPLATE feature.
 *
 * Environment variables:
 * - DATABASE_URL: Target database URL (e.g., postgresql://...@.../open_mercato_pr_123)
 * - DATABASE_ADMIN_URL: Admin database URL with postgres superuser (for CREATE DATABASE)
 */

function extractDatabaseName(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.slice(1);
}

async function cloneDatabase() {
  const targetUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;

  if (!targetUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  if (!adminUrl) {
    console.error('DATABASE_ADMIN_URL is not set');
    process.exit(1);
  }

  const targetDbName = extractDatabaseName(targetUrl);

  if (targetDbName === 'open_mercato') {
    console.log("Skipping database cloning (target is 'open_mercato')");
    process.exit(0);
  }

  console.log('==========================================');
  console.log('PR Database Cloning');
  console.log('==========================================');
  console.log(`Target database: ${targetDbName}`);
  console.log(`Source database: open_mercato`);
  console.log('');

  const adminClient = new pg.Client({ connectionString: adminUrl });

  try {
    await adminClient.connect();

    console.log('[1/4] Terminating connections to target database...');
    const targetTermResult = await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [targetDbName],
    );
    console.log(`✓ Terminated ${targetTermResult.rowCount} connection(s)`);
    console.log('');

    console.log('[2/4] Dropping existing database (if exists)...');
    await adminClient.query(`DROP DATABASE IF EXISTS "${targetDbName}"`);
    console.log("✓ Database dropped (or didn't exist)");
    console.log('');

    console.log('[3/4] Terminating connections to source database...');
    const sourceTermResult = await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'open_mercato' AND pid <> pg_backend_pid()`,
    );
    console.log(`✓ Terminated ${sourceTermResult.rowCount} connection(s)`);
    console.log('');

    console.log('[4/4] Creating database from template...');
    await adminClient.query(
      `CREATE DATABASE "${targetDbName}" TEMPLATE "open_mercato"`,
    );
    console.log(`✓ Database created from template`);
    console.log('');

    console.log('==========================================');
    console.log('✓ Database cloning completed successfully!');
    console.log('==========================================');
    console.log(`Database '${targetDbName}' is ready for use`);
    console.log('');

    await adminClient.end();
    process.exit(0);
  } catch (error) {
    console.error('Error during database cloning:');
    console.error(error);

    try {
      await adminClient.end();
    } catch {}

    process.exit(1);
  }
}

void cloneDatabase();
