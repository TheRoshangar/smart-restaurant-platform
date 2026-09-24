# DECISIONS

Format: decision / reason / alternative considered / trade-off accepted.

Entries marked **⚠︎ REVISIT** are ones I now think were wrong, or would do differently.
They are at the end, in §11–§13.

---

## 1. Build the open ticket, not the menu or the POS

**Decision.** Scope the build to one object — the table's bill — from first item to settled,
across waiter, station and cashier.

**Reason.** In a restaurant, ordering/kitchen/checkout are three views of one object. Splitting
them is a screen-level decomposition; the brief explicitly asks for a schema that reflects the
domain. The ticket is also the artefact currently living on paper, which is where the money
leaks, and the only one three roles touch at once.

**Alternative considered.** Menu management. It is the obvious "safe" build and it is a
prerequisite — but it replaces nothing. The café already has a printed menu that works. Also
considered reporting-first, rejected because reporting is a *consequence* of capturing the
ticket; build it first and you have a data-entry product.

**Trade-off accepted.** Menu CRUD is thin, reporting is thinner, and there is no reservations
or inventory story at all. Any of those could be the thing a given café asks for first.

---

## 2. Three different concurrency mechanisms, not one

**Decision.** Append-only + `FOR SHARE` for adding lines; conditional `UPDATE` for station
transitions; `FOR UPDATE` + optimistic `version` for money.

**Reason.** The three cases have different correctness requirements. Two waiters adding drinks
is *not a conflict* and must not be treated as one. A lost kitchen transition is a correctness
bug. A discount applied against a stale bill is a money bug. One mechanism cannot be right for
all three.

The `FOR SHARE` choice is the subtle one and it is deliberate: share locks are compatible with
each other, so concurrent adds don't block, but the cashier's `FOR UPDATE` in `settle()` waits
for every in-flight add to commit. That closes the gap where a pizza lands on a ticket settled
a millisecond earlier and is served free — the scenario that actually loses money, and the one
not named in the brief's list.

**Alternative considered.** A single global optimistic version on the order for every operation.
Simpler to explain, and wrong: it would make two waiters adding simultaneously a conflict, and
they would learn to work around the software.

**Trade-off accepted.** Three mechanisms is more to hold in your head, and the "where it breaks"
story is correspondingly longer (SCOPE.md §4.1).

---

## 3. Tenant isolation in Postgres RLS, not in application code

**Decision.** `ENABLE` + `FORCE` row-level security on every tenant table, policy driven by a
session GUC set from the verified JWT, app connects as a non-owner non-superuser role.

**Reason.** Application-level scoping is one forgotten `WHERE` clause away from a breach, and
that clause will eventually be forgotten — by me, at 1am, in a hotfix. RLS makes the forgotten
clause return *zero rows* instead of another restaurant's data. `FORCE` matters separately from
`ENABLE`: without it the table owner bypasses the policy, and migrations run as the owner.

**Alternative considered.** Schema-per-tenant. Genuinely stronger isolation, and it is what I
would choose for a handful of large enterprise tenants. Rejected because migrations across
thousands of schemas become an operational project of their own, and the target is many small
independent cafés. Also considered database-per-tenant: same objection, worse.

**Trade-off accepted.** Every query path must go through `withTenant()`. Forgetting it is now a
"why is everything empty" bug rather than a breach — annoying, but the right direction to fail in.

**Verified**, not asserted: `tests/tenant-isolation.test.ts` enumerates tenant tables from the
Postgres catalogue and checks read, write, delete and insert isolation plus the no-tenant case.
I confirmed it fails correctly by adding an unprotected table; it named the table.

---

## 4. Money as BIGINT current rial, with display unit as separate config

**Decision.** Store integer rial. Never store the display unit. Format at the edge.

**Reason.** This one came out of research, not instinct. Iran's redenomination law was
promulgated in Azar 1404: four zeros come off, the new rial equals 10,000 current rials, and
**both units circulate in parallel for up to three years**. Any schema that stores "price" as a
number in the unit people speak is going to be wrong twice — at cutover and for all history.

**Alternative considered.** Storing toman, the unit everyone actually uses. Rejected: it makes
the display unit implicit, which is exactly what the transition punishes. Also considered
`NUMERIC` — unnecessary, since rial has no subdivision in practice, and integer arithmetic is
easier to reason about than decimal rounding.

**Trade-off accepted.** Every number in the database is 10× what a user would say, which makes
raw SQL spot-checks mildly confusing. Cheap insurance.

---

## 5. Service charge and VAT as per-branch basis points, applied in a fixed order

**Decision.** `service_charge_bps` and `vat_bps` on the branch. Service applies to the
post-discount subtotal; VAT applies to subtotal + service. Both configurable.

**Reason.** VAT was 9% for years and moved to 10% under the 1404 budget law, and cafés were only
brought into VAT scope by the ninth tax call in 1402. Hardcoding either the rate or the
applicability would have been wrong within the year. The stacking order is the Iranian
convention; reversing the last two steps makes every bill about 1% wrong in a direction nobody
notices until an audit.

**Alternative considered.** A general rule engine for tax. Wildly out of scope for six hours and
for a product with one tax jurisdiction.

**Trade-off accepted.** No support for per-item tax rates beyond an exempt flag, and no support
for the special rates that apply to things like sugary drinks.

---

## 6. `order_type` is a tax field, not a label

**Decision.** `dine_in` / `takeaway` / `delivery` on the order, and VAT is conditional on it.

**Reason.** Takeaway-only food service is outside Iranian VAT; dine-in is not. So the question
"is this eaten here?" has a tax consequence, and a system that treats it as a UI filter will
compute the wrong bill.

**Alternative considered.** Treating VAT liability as a property of the business. Wrong: the
same café does both, on the same night, on alternating tickets.

**Trade-off accepted.** A mis-tapped order type is now a tax error, not a cosmetic one. This
argues for making it hard to change after the first line is added — which I have not done.

---

## 7. Price snapshots on order lines

**Decision.** `name_fa_snapshot` and `unit_price_irr` are copied onto the line at add time.

**Reason.** A manager raising a price at 21:00 must not silently reprice the bills already open
in the room. Joining live to `menu_items` at settle time produces bills that change under the
customer.

**Alternative considered.** Menu item versioning with validity ranges. More "correct", and more
machinery than this earns — a snapshot answers the same question for a fraction of the
complexity.

**Trade-off accepted.** Correcting a typo in an item name doesn't propagate to open tickets.
Right behaviour for price, mildly wrong for name; I accepted the inconsistency.

---

## 8. Never merge duplicate lines into a quantity

**Decision.** Two teas added separately are two rows.

**Reason.** Merging is a *display* concern, and merging at the data layer destroys who added
what and when. That is precisely the information needed when a bill is disputed or when you are
working out where the voids are coming from.

**Alternative considered.** Merging on add, which is what most POS systems do and what the UI
arguably wants. The UI can still group for display; the data should not.

**Trade-off accepted.** More rows, and the client has to group them itself.

---

## 9. AI at setup, never in the service path

**Decision.** One capability — menu import from a photo or paste — with a deterministic Persian
parser that runs first and a model that only sees what the parser couldn't handle.

**Reason.** OpenAI and Anthropic geo-block Iran outright, and international connectivity is
intermittent. So an AI call during service is a feature that fails on a Thursday night. What is
left that is genuinely valuable is the onboarding cliff: a café with 140 items will not type
them in, the system stays empty, and it never gets used. The biggest adoption risk in the
product is a data-entry task.

**Alternative considered.** An AI expediter predicting ticket times — rejected, it sits on the
critical path. Voice ordering in Persian — right ergonomics, wrong country and wrong decade for
sanctioned ASR on the critical path. A customer chatbot — tapping a menu is faster than typing
at a model; that is AI as marketing.

**Trade-off accepted.** It is not a flashy demo. It is also the only version of this feature
that still works when the provider is unreachable, which is the normal case, not the edge case.

---

## 10. Four roles

**Decision.** manager / cashier / waiter / kitchen, capability-based so one person can hold more
than one.

**Reason.** Each role blocks a specific named failure rather than modelling an org chart.
Separating cashier from waiter exists because discount authority is the main theft vector.
Kitchen sees no prices at all — the API does not send them — because there is no reason for a
line cook to know the margin and because a price column is clutter on a screen in a hot room.

**Alternative considered.** Three roles, collapsing cashier into manager. In a small café the
owner *is* the cashier, and the capability model already allows that — but making it structural
would break multi-branch, where a branch cashier is not a manager.

**Trade-off accepted.** Four is more than the minimum a single-site café needs.

---

# Things I now think were wrong

## 11. ⚠︎ REVISIT — I hand-rolled the Jalali calendar conversion

**What I did.** Implemented Borkowski's 2820-year arithmetic cycle from scratch to avoid a
dependency, reasoning that a calendar conversion is a pure function and I could demonstrate it.

**Why it was wrong.** It was subtly incorrect. It disagreed with the official Iranian calendar
on Nowruz 1404 and treated 1403 as a 365-day year when 1403 is a leap year. The arithmetic
cycle is an *approximation* of what is in practice an observational calendar, and I would not
have noticed had I not tested against published Nowruz dates — the output looked entirely
plausible.

**What I did about it.** Replaced the conversion with `jalaali-js` and kept only the part that
is genuinely domain-specific and genuinely mine: `businessDay()`, the 05:00 cutoff, and the
Saturday-anchored week. Added anchor tests.

**The lesson I'd carry.** "It's just a pure function" is the reasoning that produces wrong
calendars, wrong timezone handling and wrong currency rounding. In a product whose entire market
uses this calendar, a one-day error in monthly reporting is not cosmetic.

---

## 12. ⚠︎ REVISIT — `menu_item_branch_prices` was premature

**What I did.** Added a branch-level price override table, because branches in different parts
of Tehran genuinely do charge different prices.

**Why I'd revisit it.** It is real, but it is not *first*. It puts a `LEFT JOIN` and a `COALESCE`
into the hottest path in the system — resolving a price when a waiter taps an item — to serve a
case that none of the first ten customers will have, since almost all of them are single-site.
I built it because it made the schema look more domain-aware, which is not a good reason.

**What I'd do instead.** Ship single-price items. Add the override table when the second
multi-branch customer asks, at which point it is an additive migration and a one-line change to
the resolution query. I am keeping it in this submission because removing it now would cost more
time than it saves, which is itself a small piece of evidence for the point.

---

## 13. ⚠︎ REVISIT — per-order `seq` allocation is more machinery than it's worth

**What I did.** Line ordering via an explicit `seq` integer, allocated as `MAX(seq)+1` with a
`UNIQUE (order_id, seq)` constraint, a savepoint, and a bounded retry loop for the collision
case.

**Why I'd revisit it.** That is four moving parts — optimistic allocation, a unique constraint,
a savepoint, and a retry — to produce a number whose only job is display ordering. `added_at`
plus the primary key would order lines correctly, with no collision case, no savepoint and no
retry. I reached for `seq` because "line 1, line 2" reads naturally on a kitchen ticket, and
then paid for it in concurrency machinery.

**What I'd do instead.** Drop `seq`; order by `added_at, id`. If a human-facing line number is
wanted on a printed ticket, compute it at render time. I would keep the savepoint pattern in my
pocket — it is the right shape for genuine collision cases — but this was not one.

---

## 14. ⚠︎ REVISIT (smaller) — globally unique staff phone numbers

**What I did.** `UNIQUE` on `staff.phone` across all tenants, so login can resolve a tenant from
a phone number before a tenant is known.

**Why I'd revisit it.** It encodes the assumption that a person works at exactly one restaurant.
That is usually true and occasionally false, and when it is false the person simply cannot be
registered at the second café — a hard failure for an edge case that deserved a soft one.

**What I'd do instead.** Allow the phone to repeat, and when login matches more than one
account, return a tenant picker rather than a token. It is a slightly worse login flow for
everyone in exchange for not blocking a real case outright.

---

## 16. ⚠︎ REVISIT — my isolation tests passed while isolation was switched off

**What happened.** `tests/tenant-isolation.test.ts` asserted, among other things, that
the `mizban_app` role is not a superuser and does not have `BYPASSRLS`. It passed. Every
cross-tenant read, write and delete was correctly blocked. I was satisfied.

Then the end-to-end workflow test logged in as a manager of restaurant B, requested
restaurant A's branch, and got back **fifteen of restaurant A's live orders**.

**Why.** The application pool was connecting as `postgres`. Superusers bypass RLS
unconditionally, so every policy was inert. The isolation test had verified that *a role*
was safe; it had never verified that the *application was using that role*. The test and
the application were connecting with different credentials, and the test was the one with
the correct ones.

This is the worst kind of security bug: not a missing control, but a control that is
present, tested, passing, and doing nothing.

**What I did about it.** Three things, in order of importance:

1. Split `DATABASE_URL` (application role, RLS applies) from `DATABASE_URL_ADMIN` (owner,
   migrations and seed only). Tests now connect as the app role for anything that
   exercises the app, and as the owner only to set up fixtures and assert on state the
   app is not supposed to see.
2. Added `assertNonPrivilegedRole()`, called at boot. The server **refuses to start** if
   `current_user` is a superuser or has `BYPASSRLS`, or if it owns tables lacking
   `FORCE ROW LEVEL SECURITY`. The realistic production version of this mistake is
   someone pasting the admin connection string into `.env` because migrations needed it,
   and that must be a hard failure rather than a silent loss of every tenancy guarantee.
3. Kept the end-to-end cross-tenant assertion in the workflow suite, going through HTTP
   with a real token, because that is the layer that caught what the database-level test
   could not.

**The lesson I'd carry.** A security test that has never been seen to fail is not evidence.
I had, in the same file, written a test designed to catch future regressions — and I had
not checked that the control it verified was the one actually in the request path. Test the
system as it is deployed, not the component in isolation; and where a guarantee depends on
configuration, assert the configuration at runtime rather than trusting a test to stand in
for it.

---

## 15. Time box

Declared: six hours. **Actual: approximately seven.** The overrun is in two places, and I would
spend it the same way again:

- **~45 minutes on market research** (SCOPE.md §2), which was budgeted. It changed the money
  model, the tax model, the calendar handling and the entire AI decision. It was the highest-
  leverage time in the exercise.
- **~1 hour beyond the box** verifying rather than writing: standing up a real Postgres,
  confirming RLS fails closed, confirming the append-only trigger rejects rewrites, confirming
  the one-open-ticket-per-table index holds under a real duplicate insert, and confirming the
  isolation suite actually fails when a table is added without a policy.

I would rather declare the overrun than submit security claims I had only reasoned about.
Four bugs were found by running the thing rather than reading it:

- the RLS bypass in §16, which was the entire tenant isolation guarantee;
- a 500 instead of a 409 when two waiters raced the same table, because the conflict
  lookup ran inside an already-aborted transaction;
- a seeded order left permanently open when every one of its lines was voided, caught by
  the one-open-ticket index;
- the Jalali off-by-one in §11.

None of these were visible by inspection. All four looked correct in the code.
