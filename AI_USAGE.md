# AI_USAGE

## Tools

- **Claude (Opus)** — the primary tool, used throughout: research, schema design, most
  implementation, and the documents.
- **Web search**, through the same session, for the Iranian market research in SCOPE.md §2.

No other coding assistants were used. Everything below is written from the actual session
rather than reconstructed.

---

## Where it saved real time

**Research synthesis — the single highest-value use, ~45 minutes instead of a day.**
I did not know the Iranian tax position on cafés, the status of the currency redenomination,
or the exact shape of AI provider access from Iran. Searching Persian-language sources and
reconciling them produced three findings that changed the design rather than decorating it:
the redenomination (which determined how money is stored), the 1402 tax call bringing cafés
into VAT and the takeaway exemption (which made `order_type` a tax field), and the
geo-blocking of frontier providers (which determined that no AI call may sit on the critical
path). This research is the reason the AI capability is menu import at setup rather than
something during service, and I would not have reached that conclusion unaided.

**Boilerplate with domain content in it.** The seed file is ~400 lines of realistic Persian
café data — menu items at plausible 1405 prices, staff names, table layout including the
family section, a weekly volume curve. Writing that by hand is an hour of typing with no
thinking in it. Generated in minutes, then adjusted where the *shape* was wrong (see below).

**Migration and test scaffolding.** The reflective RLS migration — looping over
`pg_attribute` to find every table carrying `restaurant_id` — and the matching catalogue-
walking test were drafted quickly and were structurally right first time.

**Documentation drafting.** SCOPE.md and HANDOVER.md were drafted fast and then heavily
rewritten. The structure came cheap; the judgment in them did not.

---

## Where it produced something bad

**1. A calendar that was confidently wrong.**
Asked for a Jalali conversion without a dependency, it produced Borkowski's 2820-year
arithmetic cycle — well-formed, plausibly commented, and incorrect. It disagreed with the
official Iranian calendar on Nowruz 1404 and treated 1403 as a 365-day year when 1403 is a
leap year. Nothing about the output signalled a problem. I caught it only by testing
against published Nowruz dates, which I did because a calendar in a product whose entire
market uses that calendar felt worth checking rather than because I suspected anything.

The failure mode is the instructive part: it was not a syntax error or an obvious gap, it
was an approximation presented without the caveat that it *is* an approximation. Replaced
with `jalaali-js`. (DECISIONS.md §11.)

**2. Code that assumed Postgres transactions behave like they don't.**
The first `addLine` implementation had a retry loop around a unique-constraint collision
with no savepoint. In Postgres a failed statement aborts the whole transaction, so the
second attempt could only ever fail with "current transaction is aborted". The same mistake
appeared independently in `openOrder`, where it turned a clean 409 into a 500 — and that
one survived until the end-to-end test caught it.

**3. Row objects passed where UUIDs were expected.**
In the seed, `const { rows: [main1] } = await query(...)` then `main1` used as an id rather
than `main1.id`. Trivial, and it failed immediately on the first run — worth listing only
because it is the category of error that costs nothing when you run the code and costs real
time when you don't.

**4. Demo data with the wrong shape, not the wrong syntax.**
The first seed attributed every single void to one cashier. Syntactically fine, realistic-
looking, and commercially meaningless: the void report is there so an owner can spot an
outlier, and a report where one person accounts for 100% of voids teaches them nothing. I
added a second cashier and made the distribution deliberately uneven. This is the kind of
thing a model gets wrong because it is optimising for plausible-looking data rather than for
what the data is *for*.

**5. Security theatre risk in the test suite.**
The generated isolation tests were good, and they lulled me. They asserted that the
`mizban_app` role cannot bypass RLS — true — while the application was connecting as
`postgres`. The tests passed with tenant isolation entirely switched off. The model did not
create that gap on its own; I accepted a test that checked a component rather than the
deployed path. But it is a good illustration of assistance producing something that *looks*
like verification. (DECISIONS.md §16.)

---

## A recommendation I rejected

**It proposed a richer AI feature set: an AI expediter predicting ticket completion times,
demand forecasting, and a conversational ordering assistant.**

I rejected all three, and the reasoning is in SCOPE.md §5.

The expediter and the assistant both sit on the critical path of service. In a market where
frontier providers geo-block the country and international connectivity is intermittent by
default, a feature a cook waits on is a feature that fails during the dinner rush — which
is the only time it matters. Demand forecasting needs months of history; on a fourteen-day
seed it would produce confident nonsense.

What I kept is smaller and, I think, harder to argue with: menu import at setup, with a
deterministic parser that runs first and a model that only sees the residue. It works with
no API key at all. That was my constraint, not the model's suggestion — the assistant was
optimising for capability, and the binding constraint here was reachability.

The broader pattern: **on "what should I build", the assistance was consistently biased
toward more.** It is good at generating options and poor at declining them, and this
exercise is explicitly about declining them.

---

## How I verified generated code

The short version: **I ran everything, against a real database, and treated anything I had
only read as unverified.**

Specifically:
- Installed PostgreSQL 16 and ran the actual migrations rather than reviewing the SQL.
- Proved the RLS claims by executing them: reading, updating, deleting and inserting across
  tenants, plus the no-tenant-set case.
- Proved the isolation test *fails* by adding a table without a policy. A security test
  never observed failing is not evidence.
- Verified the append-only trigger by trying to rewrite an event, and the one-open-ticket
  index by racing a duplicate insert.
- Checked pure functions against external ground truth — Nowruz dates for the calendar,
  hand-computed bills for the tax stacking.
- Ran the full workflow end to end through HTTP with real tokens for all four roles, then
  booted the server and hit it with curl.
- Ran the suite twice consecutively to confirm it is repeatable rather than order-dependent.

Four bugs were found by running and zero by reading. All four looked correct in the source.
That ratio is the argument for the approach.

---

## What was my own thinking

The architecture, and specifically the parts that carry judgment:

**Choosing the ticket as the workflow**, and the argument for why ordering, kitchen and
checkout are one object rather than three screens. Also the argument against the obvious
safe choice (menu CRUD) on the grounds that it replaces nothing.

**Using three different concurrency mechanisms rather than one**, and the reasoning that
two waiters adding drinks is not a conflict and must not be modelled as one. The `FOR SHARE`
choice in `addLine` is mine and is the subtle part: share locks let concurrent adds proceed
while still forcing the cashier's `FOR UPDATE` to wait, which closes the gap where an item
lands on a just-settled ticket. That scenario is not in the brief's list and is the one that
actually loses money.

**The fail-closed property of the RLS design** — that an unset tenant should produce an
empty database rather than a shared one — and the decision to enforce it at boot after the
superuser bug.

**Deciding what the AI capability should be**, against the constraint the research
surfaced. Rejecting the ambitious versions was the actual work.

**The business-day boundary.** No source suggested it; it comes from knowing that a café
closing at 2am will tell you your reports are wrong. Every financial query keys on it.

**Separating storage unit from display unit for money** once the redenomination finding
landed — the finding was assisted, the architectural consequence was not.

**Which limitations to state and how plainly**, especially in HANDOVER.md. Assistance
drafts toward reassurance; the brief explicitly says understating limitations costs more
than the limitations themselves, and that section was rewritten to be blunter than the
draft.

**What not to build.** Modifiers, inventory, bill splitting, Moadian transmission,
reservations — all deliberate omissions with reasons, and all things a model will happily
add if you let it.
