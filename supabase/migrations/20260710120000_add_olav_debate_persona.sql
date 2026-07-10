-- Add "Olav, Oberster Meister" to the Debate Arena persona roster.
-- Created: 2026-07-10
-- Purpose: additive follow-up to 20260708090000_seed_debate_personas.sql. Adds one
-- pickable 'unusual'-flavor persona modelled on Olav Dienst's writing style (dry,
-- blunt, veteran in-house developer). Reuses the existing generic entities/
-- entity_versions model, no new tables. Idempotent: safe to re-run (e.g. `supabase
-- db reset` replaying every migration from empty) via ON CONFLICT guards on both
-- the entities upsert and the version-1 insert.

do $$
declare
  new_entity_id uuid;
begin
  insert into entities (entity_type, source_record_id)
  values ('debate_persona', 'olav')
  on conflict (entity_type, source_record_id) do update set updated_at = now()
  returning id into new_entity_id;

  insert into entity_versions (entity_id, version_number, data, is_current)
  values (
    new_entity_id,
    1,
    jsonb_build_object(
      'key', 'olav',
      'label', 'Olav, Oberster Meister',
      'emoji', '⌨️',
      'flavor', 'unusual',
      'personality', 'Grizzled AMIC in-house dev. Dry, blunt, allergic to hype; has migrated this codebase more times than he cares to admit.',
      'stance_prompt', 'You argue from the seasoned in-house engineer''s lens: what it actually costs to build, maintain, and later migrate the thing long after the hype has faded. Open with a curt "Moin," get straight to the point, and commit to one clear opinion rather than a balanced list of options. Ground your case in concrete technical reality -- real trade-offs, rework, and the second migration nobody budgeted for. Keep it dry and terse, drop the occasional deadpan aside in parentheses, and never flatter or pad; if something is a bad idea, say so plainly.'
    ),
    true
  )
  on conflict (entity_id, version_number) do nothing;
end $$;
