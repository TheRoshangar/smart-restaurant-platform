# راهنمای تحویل — Handover

**Written for the owner, not for an engineer.** No technical knowledge assumed.

---

## What you have

A system that replaces the paper order pad.

Right now, an order for table 12 exists on a piece of paper in a waiter's apron. The
kitchen finds out about it when someone walks over. The cashier works out the bill by
reading handwriting. At the end of the month you add it all up yourself.

This system puts that one piece of paper — the table's bill — in one place that everyone
can see at the same time. The waiter adds items on a phone, the kitchen and the bar see
them appear on their own screen, and the cashier sees a bill that is already correct.

It is built for many restaurants, and **one restaurant can never see another's
information**. Not the menu, not the sales, not the staff. This is enforced by the
database itself, not by the app being careful, and there is a test that checks it
automatically every time the code changes.

---

## The main workflow — your staff could use this on Monday

**The waiter**
1. Opens the app on a phone, enters their number and PIN.
2. Taps a table. If someone else has already opened that table, it says so — you can't
   accidentally end up with two bills for table 12.
3. Taps items from the menu. Each one is added instantly and everyone else sees it.
4. When food arrives at the table, taps it as served.

**The kitchen and the bar**
- Each has its own screen showing only what they have to make, oldest first, with how long
  it has been waiting.
- Two taps: "started" and "ready".
- **They never see prices.** There is no reason for the kitchen to know your margins, and
  it keeps the screen clean.

**The cashier**
1. Opens the table's bill. Everything is already there and already added up, including
   service charge and tax.
2. Can apply a discount — but must type a reason, and it is recorded against their name.
3. Takes payment. Cash, card machine, card-to-card, or a mix — two friends paying
   separately on one bill is normal and supported.
4. Closes the bill. The table is free again immediately.

**You, the owner**
- Daily sales, broken down by payment method, with your best-selling items.
- **A void report.** Every item that was cancelled: what it was, what it was worth, who
  cancelled it, and why. This is the one screen I would ask you to look at weekly. Cancelled
  items are how money leaves a restaurant quietly, and until now you had no way to see the
  pattern.
- Everything is in the Persian calendar, and a night that runs past midnight is counted as
  one night, not split across two days.

### Things it already handles that you'd otherwise get wrong

- **Prices are frozen when the item is added.** If you raise the price of a coffee at 9pm,
  the bills already open in the room do not change. Only new orders use the new price.
- **Takeaway is not charged VAT; eating in is.** The system knows the difference.
- **The new currency.** The country is in the middle of removing four zeros from the money,
  with both old and new in use for up to three years. The system stores every amount in a
  way that does not care which one you are using, and can print a receipt showing both. You
  will not need new software when the changeover happens.

---

## Known limitations — read this part

I would rather you hear these from me now than discover them on a busy Thursday.

**1. It does not work without internet.** This is the biggest one. If the café's connection
drops, waiters cannot add orders until it comes back. Given how connections behave here,
this *will* happen to you. The groundwork is done — the system is already built so that a
repeated order can never be charged twice — but the part that lets a phone keep working
while offline is not built yet. It is the first thing I would build next.

**2. No "no onion", no "large size", no "extra shot".** You can type a free-text note on an
item, and the kitchen will see it, but the system does not understand sizes or options. If
your menu has a single and a double espresso at different prices, they have to be two
separate menu items. This is the most commonly missed feature and it is second on the list.

**3. It does not know your stock.** If you run out of cheesecake, someone has to mark it
unavailable by hand. It will not count down as you sell.

**4. It does not send invoices to the tax system (سامانه مودیان).** It records everything
you would need — including a field on every menu item for the tax code — but it does not
yet transmit. You still do that the way you do today. This is a real legal obligation and
it is third on the list.

**5. You cannot move a bill between tables, or split a bill by person.** If a group moves
from the terrace to inside, the bill has to be closed and reopened. If four people want
four separate bills, the cashier has to work it out manually. You *can* take several
payments against one bill, which covers most of it.

**6. It has not yet been used in a real restaurant.** It has been tested thoroughly,
including the situations where several people touch the same bill at once, but tested is
not the same as survived a Thursday night. The first two weeks should be run alongside your
existing method, not instead of it.

**7. One screen at a time per role is the tested configuration.** More screens will work,
but if you run this across many devices at once and something looks out of date, refreshing
fixes it. Nothing is lost — the bill in the database is always correct.

**8. There is no customer-facing part.** No QR menu, no online ordering, no delivery app
integration.

---

## What I would build next, in order

**1. Working without internet (2–3 weeks)**
Because it is the difference between "usually works" and "works". Everything else on this
list assumes the staff can actually use the system during service. The hard part — making
sure a repeated order is never charged twice — is already done.

**2. Item options and sizes (1–2 weeks)**
Single/double, milk choice, no onion. It is the thing your staff will ask for in week one,
and the thing that makes the printed menu and the system finally match.

**3. Sending invoices to the tax system (3–4 weeks)**
A legal requirement, and it removes a monthly job you currently do by hand. It is slower
than it sounds because it needs registration, a fiscal ID and a signing key, and those are
paperwork before they are software. Worth doing third, not first, because getting it wrong
is worse than doing it later.

**4. Better reports, then automatic summaries (1–2 weeks, then 1 week)**
Once there are a few months of real trading, the system can tell you things rather than
just show you numbers — "cancellations were up 40% last week, almost all on the night
shift". I deliberately did not build this yet: with only demo data it would be inventing
patterns, and a report that sounds confident and is wrong is worse than no report.

**5. Moving and splitting bills (1 week)**
Genuinely useful, genuinely annoying when missing — but it costs the cashier a minute, not
a sale, which is why it is last.

---

## Where this stops working as you grow

**At 10 restaurants — fine, no changes needed.**
Everything runs comfortably on one modest server. Your cost is a few dollars a month.

**At 1,000 restaurants — one specific thing breaks first.**
The live-updating screens. Right now, all the screens talk to a single copy of the program.
As soon as we need a second copy running to handle the load, a waiter connected to copy A
stops seeing updates from copy B — their screen goes stale, though no order is ever lost.
This is roughly a day's work to fix, and it is the *only* thing that has to change at this
scale. Everything else — the database, the security, the bills — is built to handle it. Old
orders would also be moved to slower, cheaper storage so that searching recent ones stays
fast.

**At 100,000 restaurants — a genuine rebuild of one part.**
At that size a single database is no longer enough and the data has to be spread across
many, grouped by restaurant. Because every piece of information in the system already
carries a restaurant on it, that split is possible without redesigning anything — but it is
months of careful work, and it is the point at which you need a team rather than a person.

**The honest note:** I have not designed for 100,000. Designing today for a scale you do
not have is the most common way small products die — you spend the money on complexity
instead of on the features that would have got you the customers. The architecture leaves
the door open; it does not walk through it early.

---

## If something goes wrong

Every action is recorded permanently: who added an item, who cancelled one, who gave a
discount, who closed a bill, and the exact time of each. **These records cannot be edited or
deleted by anyone**, including me and including the system itself. When a customer disputes
a bill, or you want to know what happened on table 8 last Tuesday, the answer exists.

If a screen shows something unexpected, the bill stored in the system is the correct one.
Refresh, and it will match.
