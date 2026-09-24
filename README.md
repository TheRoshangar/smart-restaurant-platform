# میزبان (Mizbān)

An order-management backend for Iranian cafés and restaurants. It covers one
workflow end to end — **the open ticket**, from the waiter's first item to the
cashier's settlement — for many independent restaurants, with hard tenant
isolation.

Read [`SCOPE.md`](./SCOPE.md) first. It explains what was built and, more
importantly, what wasn't and why. [`DECISIONS.md`](./DECISIONS.md) records the
calls, including the ones that turned out wrong.

---

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
# set JWT_SECRET — there is no default, the server refuses to start without one
openssl rand -base64 48

npm run setup     # installs, starts Postgres, migrates, seeds
npm run dev
```

`npm run setup` is `npm install && docker compose up -d --wait && npm run migrate && npm run seed`.

```bash
npm test          # 55 tests, against a real Postgres
npm run typecheck
```

### Demo credentials

Log in with a phone number and a PIN. All of these belong to **کافه نقشینه**:

| Role | Phone | PIN | Name |
|---|---|---|---|
| مدیر (manager) | `09121110001` | `1234` | مریم رضایی |
| صندوق (cashier, day) | `09121110002` | `1111` | سعید کاظمی |
| صندوق (cashier, night) | `09121110008` | `7777` | فرشته احمدی |
| گارسون (waiter) | `09121110003` | `2222` | نگار موسوی |
| گارسون (waiter) | `09121110004` | `3333` | امیر حسینی |
| آشپزخانه (kitchen) | `09121110005` | `4444` | بهزاد فتحی |

A **second restaurant** exists so you can verify isolation yourself rather than
take my word for it — log in as `09129990001` / `9999` and confirm you can see
nothing belonging to the café above, including by passing its branch id directly.

The seed produces 14 days of trading (~610 orders, ~2,140 lines) with a realistic
shape: Thursday nights peak because Friday is the weekend, late evening dominates,
3.4% of lines are voided, and one cashier voids about three times as much as the
other — which is the pattern the void report exists to surface.

---

## Architecture

```
src/
  domain/orders.ts     the ticket: open, add, advance, void, discount, settle
  lib/
    db.ts              pool + withTenant() — sets the RLS tenant GUC per transaction
    auth.ts            phone+PIN login, JWT, capability checks
    idempotency.ts     replay-safe writes
    totals.ts          discount -> service charge -> VAT stacking
    money.ts           integer rial, redenomination-aware display
    calendar.ts        Jalali rendering + business-day boundary
    events.ts          in-process SSE fan-out
    errors.ts          typed errors; 409s carry current state
    log.ts             structured logging with ticket context
  http/
    app.ts             Fastify factory, auth hook, fail-closed error handler
    routes/            auth, orders, menu (+ AI import), reports, stream
  ai/menuImport.ts     deterministic Persian parser, then optional model
db/
  migrations/          0001 schema, 0002 RLS
  seed.ts              demo data
```

**Stack:** Node 20 / TypeScript / Fastify / Postgres 16 / Zod / Vitest. No ORM —
the interesting parts of this system are `FOR SHARE` vs `FOR UPDATE`, conditional
updates, partial unique indexes and RLS policies, all of which an ORM obscures.

### The three guarantees, and where they live

| Guarantee | Mechanism | Where |
|---|---|---|
| Restaurant A never sees B | Postgres RLS, `ENABLE` + `FORCE`, fails closed when the tenant GUC is unset | `db/migrations/0002_rls.sql` |
| Concurrent adds never lost | Append-only lines + `FOR SHARE`; the cashier's `FOR UPDATE` waits for in-flight adds | `src/domain/orders.ts` |
| Station transitions never lost | Conditional `UPDATE ... WHERE status = $expected`; zero rows → 409 with current state | `src/domain/orders.ts` |
| Money never applied to a stale bill | `FOR UPDATE` + `If-Match` version → 409 with the fresh bill | `src/domain/orders.ts` |
| One open ticket per table | Partial unique index | `db/migrations/0001_init.sql` |
| Audit trail is immutable | `BEFORE UPDATE OR DELETE` trigger + revoked grants | `db/migrations/0001_init.sql` |
| Retries don't duplicate | `Idempotency-Key` stored per tenant with the response | `src/lib/idempotency.ts` |

The app **refuses to boot** if its database role can bypass RLS. That check exists
because it caught a real bug here: the isolation tests passed while the app was
connecting as a superuser, making every policy silently inert. See DECISIONS.md §16.

---

## Security

Four risks that matter for what was actually built.

**1. Cross-tenant access.** Handled by RLS in the database rather than `WHERE`
clauses in the application, because the application clause is the one that gets
forgotten. Proven by `tests/tenant-isolation.test.ts`, which enumerates
tenant-scoped tables from the Postgres catalogue rather than a hardcoded list — a
table added next year without a policy fails the suite on the day it is added. I
verified the test fails correctly by adding an unprotected table; it named it.

**2. Staff fraud.** The realistic threat in a restaurant is not an external
attacker, it is voids and discounts. So: voiding requires an elevated role and a
mandatory reason, discounts require a reason and record an approver, every one
writes an immutable event, and the void report aggregates by staff member so an
outlier is visible. The event log cannot be edited or deleted by anyone,
including the application role.

**3. Prompt injection via menu import.** The input is untrusted by definition — a
photo of a poster, or text pasted from Instagram. Containment is structural, not
filtering: the model has no tools and no database access, no other tenant's data
is ever in the prompt, output is constrained to a flat JSON schema with sanity
bounds on price, and **nothing is written until a human approves each row**. The
worst an injected instruction achieves is a proposal a manager rejects at a glance.

**4. Credential attacks on a shared-device product.** A 4-digit PIN is 10,000
guesses. Login is rate limited to 10/minute per IP, PINs are argon2id, failed
logins are logged with the phone and never the PIN, and an unknown phone is
verified against a dummy hash so response timing doesn't reveal which numbers
belong to staff. Tokens last one shift, not one week.

**Secrets:** `JWT_SECRET` has no default and the server exits if it is missing or
under 32 characters. The AI key lives server-side only and never reaches a browser.
`.env` is gitignored; `.env.example` carries no values.

---

## Testing

55 tests. What they cover and, more usefully, what they don't.

**Covered:**
- A full service end to end through HTTP — open, route to two stations, advance,
  serve, discount, split-payment settle, and the arithmetic closing against the
  stored snapshot.
- Each of the three concurrency mechanisms individually, including the
  money-losing case (an item arriving on a just-settled ticket) and idempotent retry.
- Tenant isolation, reflectively.
- Money parsing and formatting across all three currency units, and the
  discount → service → VAT stacking order.
- Jalali conversion against published Nowruz anchors, and the business-day cutoff.
- Model output validation — the injection containment boundary.

**Deliberately not covered, and why:**

- **The SSE stream.** Testing it properly means testing reconnection, proxy
  buffering and heartbeats, which needs a real network rather than an in-process
  harness. Nothing depends on an event arriving — screens re-read full state on
  reconnect — so a broken stream costs staleness, not correctness. The risk is
  low and the test would be expensive and flaky.
- **True parallel database contention.** The concurrency tests are sequential and
  assert the *mechanisms* (a conditional update matching zero rows, a version
  mismatch, a unique violation). Genuine parallel load testing needs a harness
  that can hold transactions open at chosen points; the mechanisms themselves are
  Postgres primitives I trust more than a racy test.
- **Live AI provider calls.** Tests run against no key, which exercises the
  heuristic path — the one that matters, since it is what runs in production most
  of the time. The model path is tested through `validateModelOutput`, where the
  security boundary actually is.
- **Reports beyond a smoke test.** They are aggregate SQL over data the workflow
  tests already produce. Low risk, and they would mostly test Postgres.
- **The redenomination cutover itself.** `format()` is tested in all three units,
  but there is no test of a live switch because there is nothing yet to switch.

---

## Deployment

Target is domestic Iranian PaaS (Liara / ArvanCloud / Parspack) or a VPS — foreign
cloud is not available. Requires Postgres 16 and HTTPS termination in front.

```bash
npm ci --omit=dev && npm run build
DATABASE_URL_ADMIN=... npm run migrate
DATABASE_URL=... JWT_SECRET=... npm start
```

Health check on `/health`. The process refuses to start on invalid configuration,
an unreachable database, or a database role that can bypass RLS.

---

## What this does not do

Stated plainly, and expanded in [`HANDOVER.md`](./HANDOVER.md): no offline mode,
no item modifiers, no inventory, no bill splitting by seat, no reservations, no
Moadian e-invoice transmission, no customer-facing menu, and no web UI in this
repository — the deliverable here is the API, the data model and the guarantees.
