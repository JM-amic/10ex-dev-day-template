-- Enable RLS + permissive dev policies for the anon/authenticated roles
-- Created: 2026-07-07
-- Purpose: the frontend reads/writes these tables via the Supabase anon key
-- (see frontend/src/data/supabase.ts, ActionDispatcher.ts). With RLS enabled
-- and no policies, PostgREST denies every request (42501 permission denied).
-- No auth/tenancy model exists yet in this template, so these policies are
-- deliberately permissive (any anon/authenticated request may read or write
-- any row). Before this goes anywhere near production, replace them with
-- policies scoped to organisation/user/role per the project's actual rules --
-- see Guide_for_agents_using_supabase_template.md section 10.4.
--
-- Table-level GRANTs are required in addition to RLS policies: RLS decides
-- which ROWS a role can see once it's allowed at the table, but PostgreSQL
-- still denies access to the table entirely without an explicit GRANT.

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  entities,
  entity_versions,
  relationships_v2,
  fact_types,
  entity_facts,
  time_series_points
to anon, authenticated;

alter table entities enable row level security;
alter table entity_versions enable row level security;
alter table relationships_v2 enable row level security;
alter table fact_types enable row level security;
alter table entity_facts enable row level security;
alter table time_series_points enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'entities',
    'entity_versions',
    'relationships_v2',
    'fact_types',
    'entity_facts',
    'time_series_points'
  ]
  loop
    execute format(
      'create policy dev_allow_all_anon on %I for all to anon using (true) with check (true);',
      t
    );
    execute format(
      'create policy dev_allow_all_authenticated on %I for all to authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;
