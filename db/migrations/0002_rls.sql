-- 0002_rls.sql — tenant isolation (SCOPE.md §4.2)
--
-- The load-bearing guarantee lives here, not in application code.
-- A forgotten WHERE clause returns zero rows, not another restaurant's data.

-- ---------------------------------------------------------------------------
-- The tenant context
-- ---------------------------------------------------------------------------
--
-- Reads a session GUC set from the verified JWT at the start of every request.
-- If the GUC is unset it returns NULL. `restaurant_id = NULL` is NULL, not true,
-- so the row is invisible. This is the fail-closed property: forgetting to set
-- the tenant makes the database look empty rather than making it look shared.

CREATE OR REPLACE FUNCTION app.current_restaurant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Apply RLS to every table that carries restaurant_id
-- ---------------------------------------------------------------------------
--
-- Done reflectively so that a table added later without a policy is a visible
-- omission rather than a silent leak. tests/tenant-isolation.test.ts walks the
-- same catalogue and fails if any tenant-scoped table is unprotected.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'restaurant_id'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.table_name);
    -- FORCE so that even the table owner is subject to the policy.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.table_name);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.table_name);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        USING      (restaurant_id = app.current_restaurant_id())
        WITH CHECK (restaurant_id = app.current_restaurant_id())
    $p$, t.table_name);
  END LOOP;
END $$;

-- `restaurants` itself is keyed on id, not restaurant_id.
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON restaurants;
CREATE POLICY tenant_isolation ON restaurants
  USING      (id = app.current_restaurant_id())
  WITH CHECK (id = app.current_restaurant_id());

-- ---------------------------------------------------------------------------
-- The one deliberate hole: login
-- ---------------------------------------------------------------------------
--
-- Authentication must resolve a phone number to a tenant before a tenant is known,
-- so it cannot run under the policy. It runs through this narrow SECURITY DEFINER
-- function instead of a broad bypass. It returns only what auth needs, it is the
-- only such function in the system, and every call is logged (see src/routes/auth.ts).

CREATE OR REPLACE FUNCTION app.lookup_staff_for_login(p_phone text)
RETURNS TABLE (
  staff_id      uuid,
  restaurant_id uuid,
  branch_id     uuid,
  role          text,
  full_name     text,
  pin_hash      text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE AS $$
  SELECT s.id, s.restaurant_id, s.branch_id, s.role, s.full_name, s.pin_hash
  FROM staff s
  JOIN restaurants r ON r.id = s.restaurant_id
  WHERE s.phone = p_phone
    AND s.is_active
    AND r.is_active
  LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------
--
-- The app connects as a non-owner, non-superuser role. Owners bypass RLS unless
-- FORCE is set (it is, above) and superusers bypass it unconditionally (so we
-- never connect as one). Belt and braces.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mizban_app') THEN
    CREATE ROLE mizban_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO mizban_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mizban_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mizban_app;
GRANT EXECUTE ON FUNCTION app.current_restaurant_id() TO mizban_app;
GRANT EXECUTE ON FUNCTION app.lookup_staff_for_login(text) TO mizban_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mizban_app;

-- The event log is append-only for everyone, including the app.
REVOKE UPDATE, DELETE ON order_events FROM mizban_app;
