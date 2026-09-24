import 'dotenv/config';
// Tests run against a real Postgres. There is no mocking layer for RLS —
// mocking the database would mock away the exact thing under test.
// DATABASE_URL is the application role (RLS applies). DATABASE_URL_ADMIN is the
// owner, used only to set up fixtures and to assert on state the app cannot see.
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_ADMIN) {
  throw new Error(
    'DATABASE_URL (app role) and DATABASE_URL_ADMIN (owner) must both be set. ' +
    'Run: docker compose up -d && npm run migrate && npm run seed');
}
