/**
 * Migration runner.
 *
 * Deliberately ~60 lines rather than a framework. Migrations are ordered SQL files,
 * applied once, recorded in a table. A senior reviewer can read the whole mechanism
 * in one screen and know exactly what ran against production.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_ADMIN is not set (copy .env.example to .env)');

  // Migrations run as the owner, not as mizban_app: creating policies and roles
  // requires privileges the application role deliberately does not have.
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations'))
        .rows.map((r) => r.filename),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file}`);
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  apply ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAIL  ${file}`);
        throw err;
      }
    }
    console.log('migrations up to date');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
