-- Creates the application role at container init, before migrations.
-- The application connects as this role and nothing else. It is not a superuser
-- and does not have BYPASSRLS, which is what makes row-level security real
-- rather than decorative.
CREATE ROLE mizban_app LOGIN PASSWORD 'mizban_app';
