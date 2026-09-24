-- 0001_init.sql — core domain schema
--
-- Money convention (see SCOPE.md §2.1):
--   All amounts are BIGINT, in CURRENT RIALS. Never float, never decimal string.
--   Display unit (rial / toman / new_rial) is a presentation concern, per branch.
--   Iran is mid-redenomination; storage unit and display unit must not be the same thing.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Tenancy root
-- ---------------------------------------------------------------------------

CREATE TABLE restaurants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  legal_name    text,
  national_id   text,                 -- شناسه ملی / کد اقتصادی, needed for Moadian later
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text        NOT NULL,

  timezone      text        NOT NULL DEFAULT 'Asia/Tehran',

  -- A cafe closing at 02:00 must not split its night across two report days.
  business_day_cutoff_hour smallint NOT NULL DEFAULT 5
    CHECK (business_day_cutoff_hour BETWEEN 0 AND 11),

  -- Rates in basis points. VAT was 9% for years and moved to 10% in 1404;
  -- service charge is customary ~10%. Neither is a constant.
  service_charge_bps int NOT NULL DEFAULT 1000 CHECK (service_charge_bps BETWEEN 0 AND 3000),
  vat_bps            int NOT NULL DEFAULT 1000 CHECK (vat_bps BETWEEN 0 AND 3000),
  vat_applies_to_service boolean NOT NULL DEFAULT true,

  money_display_unit text NOT NULL DEFAULT 'toman'
    CHECK (money_display_unit IN ('rial','toman','new_rial')),
  -- During the redenomination transition, receipts show both units.
  show_dual_currency boolean NOT NULL DEFAULT false,

  moadian_memory_id text,             -- شناسه یکتای حافظه مالیاتی, null until registered

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Identity in Iran is a phone number, not an email.
  phone         text NOT NULL,        -- E.164, +989xxxxxxxxx
  full_name     text NOT NULL,
  pin_hash      text NOT NULL,        -- argon2id over a 4-6 digit PIN

  role          text NOT NULL CHECK (role IN ('manager','cashier','waiter','kitchen')),

  -- NULL branch_id = all branches of this restaurant (owner / multi-site manager)
  branch_id     uuid REFERENCES branches(id) ON DELETE SET NULL,

  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Phone is globally unique: login must resolve a tenant before a tenant is known.
-- Trade-off recorded in DECISIONS.md (a person cannot work at two restaurants).
CREATE UNIQUE INDEX staff_phone_uniq ON staff (phone) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Room
-- ---------------------------------------------------------------------------

CREATE TABLE dining_tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id)     ON DELETE CASCADE,
  label         text NOT NULL,        -- '12', 'تراس ۳'

  -- 'family' = سالن خانوادگی. Social structure of the room, not decoration.
  area          text NOT NULL DEFAULT 'hall'
    CHECK (area IN ('hall','terrace','family','bar','takeaway')),

  seats         smallint,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, label)
);

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------

CREATE TABLE menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name_fa       text NOT NULL,
  name_en       text,
  sort_order    int  NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id)      ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES menu_categories(id)  ON DELETE RESTRICT,

  name_fa       text NOT NULL,
  name_en       text,
  description_fa text,

  base_price_irr bigint NOT NULL CHECK (base_price_irr >= 0),

  -- Kitchen and bar are genuinely separate queues; this routes the line.
  station       text NOT NULL DEFAULT 'kitchen'
    CHECK (station IN ('kitchen','bar','none')),

  is_vat_exempt boolean NOT NULL DEFAULT false,
  tax_item_code text,                 -- شناسه کالا/خدمت, nullable until Moadian work

  prep_minutes  smallint,
  is_available  boolean NOT NULL DEFAULT true,   -- "86'd" for tonight
  sort_order    int NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX menu_items_category_idx ON menu_items (restaurant_id, category_id);

-- Branch price overrides: a Tehran branch and a Mashhad branch do not charge the same.
CREATE TABLE menu_item_branch_prices (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id  uuid NOT NULL REFERENCES menu_items(id)  ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id)    ON DELETE CASCADE,
  price_irr     bigint NOT NULL CHECK (price_irr >= 0),
  PRIMARY KEY (menu_item_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- The ticket
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id)    ON DELETE CASCADE,
  table_id      uuid REFERENCES dining_tables(id),       -- NULL for takeaway

  -- Tax-relevant, not a UI label: takeaway-only service is VAT-exempt in Iran.
  order_type    text NOT NULL DEFAULT 'dine_in'
    CHECK (order_type IN ('dine_in','takeaway','delivery')),

  status        text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','settled','voided')),

  guest_count   smallint,
  note          text,

  opened_by     uuid NOT NULL REFERENCES staff(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_by     uuid REFERENCES staff(id),
  closed_at     timestamptz,

  -- Computed at open time from branch cutoff hour. All financial reporting keys on this.
  business_day  date NOT NULL,

  -- Optimistic concurrency control for money-affecting operations only.
  version       integer NOT NULL DEFAULT 1,

  -- Settlement snapshot; NULL while open. Recomputed server-side, never trusted from client.
  subtotal_irr  bigint,
  discount_irr  bigint,
  service_irr   bigint,
  vat_irr       bigint,
  total_irr     bigint,

  CONSTRAINT dine_in_needs_table CHECK (order_type <> 'dine_in' OR table_id IS NOT NULL),
  CONSTRAINT settled_has_totals  CHECK (status <> 'settled' OR total_irr IS NOT NULL)
);

-- Two waiters cannot open two tickets on table 12. Enforced by the database, not by a check-then-insert.
CREATE UNIQUE INDEX one_open_ticket_per_table
  ON orders (table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE INDEX orders_branch_day_idx ON orders (restaurant_id, branch_id, business_day);
CREATE INDEX orders_open_idx ON orders (restaurant_id, branch_id) WHERE status = 'open';

CREATE TABLE order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,
  seq           int  NOT NULL,

  menu_item_id  uuid REFERENCES menu_items(id),

  -- Snapshots. A price change at 21:00 must not alter bills already open.
  name_fa_snapshot   text   NOT NULL,
  unit_price_irr     bigint NOT NULL CHECK (unit_price_irr >= 0),
  is_vat_exempt      boolean NOT NULL DEFAULT false,

  qty           smallint NOT NULL CHECK (qty > 0),
  station       text NOT NULL CHECK (station IN ('kitchen','bar','none')),
  note          text,

  status        text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','preparing','ready','served','void')),

  added_by      uuid NOT NULL REFERENCES staff(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  ready_at      timestamptz,
  served_at     timestamptz,

  voided_by     uuid REFERENCES staff(id),
  voided_at     timestamptz,
  void_reason   text,

  CONSTRAINT void_needs_reason CHECK (status <> 'void' OR void_reason IS NOT NULL),
  UNIQUE (order_id, seq)
);

CREATE INDEX order_lines_order_idx   ON order_lines (order_id);
CREATE INDEX order_lines_station_idx ON order_lines (restaurant_id, station, status)
  WHERE status IN ('queued','preparing','ready');

-- ---------------------------------------------------------------------------
-- Append-only event log: audit trail, fraud control, and 3am debugging surface
-- ---------------------------------------------------------------------------

CREATE TABLE order_events (
  id              bigserial PRIMARY KEY,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_staff_id  uuid REFERENCES staff(id),
  actor_role      text,
  request_id      text,
  idempotency_key text,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_events_order_idx ON order_events (order_id, id);
CREATE INDEX order_events_type_idx  ON order_events (restaurant_id, type, at);

-- Append-only is enforced by the database, not by discipline.
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Money out
-- ---------------------------------------------------------------------------

CREATE TABLE order_discounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,

  kind          text NOT NULL CHECK (kind IN ('percent','amount')),
  value         bigint NOT NULL CHECK (value > 0),   -- bps if percent, rial if amount

  reason        text NOT NULL,                        -- never optional: this is the fraud control
  approved_by   uuid NOT NULL REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz,
  CONSTRAINT percent_in_range CHECK (kind <> 'percent' OR value <= 10000)
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,

  -- We record payment; we are not the payment processor. The card terminal is the bank's.
  method        text NOT NULL
    CHECK (method IN ('cash','pos_card','card_to_card','online_psp','on_account')),
  amount_irr    bigint NOT NULL CHECK (amount_irr > 0),
  reference     text,               -- terminal trace no / شماره پیگیری
  psp           text,

  taken_by      uuid NOT NULL REFERENCES staff(id),
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id)    ON DELETE CASCADE,
  business_day  date NOT NULL,

  opened_by     uuid NOT NULL REFERENCES staff(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opening_float_irr bigint NOT NULL DEFAULT 0,

  closed_by     uuid REFERENCES staff(id),
  closed_at     timestamptz,
  counted_cash_irr  bigint,
  expected_cash_irr bigint,
  note          text
);

CREATE UNIQUE INDEX one_open_shift_per_branch
  ON shifts (branch_id) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Idempotency: the network will drop, the client will retry
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status int  NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, key)
);

CREATE INDEX idempotency_gc_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- AI menu import (see SCOPE.md §5)
-- ---------------------------------------------------------------------------

CREATE TABLE menu_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  source        text NOT NULL CHECK (source IN ('text','photo')),
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','parsed','failed','applied','discarded')),

  -- Observability for a provider we do not control and cannot always reach.
  provider      text,
  model         text,
  latency_ms    int,
  parsed_by     text CHECK (parsed_by IN ('heuristic','model','mixed')),

  proposed      jsonb,             -- never written to menu_items without human approval
  error         text,

  created_by    uuid NOT NULL REFERENCES staff(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz
);
