-- Grant service_role access to the core entity tables
-- Created: 2026-07-07
-- Purpose: 20260707103039_enable_rls_dev_policies.sql granted table-level access
-- to anon/authenticated (the frontend's Supabase key) but not service_role.
-- The Temporal worker (temporal/src/activities/supabase_core.py) authenticates
-- as service_role via SUPABASE_SERVICE_ROLE_KEY, so without this grant every
-- worker write fails with PostgREST 42501 "permission denied for table ...",
-- independent of RLS (service_role bypasses RLS, but table-level GRANTs are a
-- separate Postgres privilege layer that RLS bypass does not substitute for).

grant usage on schema public to service_role;
grant select, insert, update, delete on
  entities,
  entity_versions,
  relationships_v2,
  fact_types,
  entity_facts,
  time_series_points
to service_role;
