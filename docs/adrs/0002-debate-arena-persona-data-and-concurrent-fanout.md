# ADR-0002: Debate Arena — persona roster as seeded data, and concurrent per-round activity fan-out

- **Status:** Proposed
- **Date:** 2026-07-08
- **Deciders:** Jonas Muegge (spec, plan, and ADR drafted with Claude Code assistance)
- **Supersedes / Superseded by:** None

## Context

The Multi-Agent Debate Arena feature (`docs/specs/debate-arena.md`) needs a fixed roster of 12
pickable debater personas plus one judge persona, each carrying a genuine argumentative lens (not
just flavor text), and needs to run several personas' model calls per round without serializing
them one at a time the way the only existing workflow does. Two decisions had to be made: where
the persona roster lives, and how a round's per-persona turns are orchestrated.

Constraints discovered while designing this, verified against the actual code:
- `entities`/`entity_versions`/`relationships_v2` (`supabase/migrations/20251202090000_core_entity_model.sql`)
  is the only data-modeling primitive this template offers; there is no separate
  reference-data/config table, and adding one would be a new table for a workshop-scale feature.
- `entities.source_record_id` already has a unique constraint (`uq_entities_source`) used by
  `create_entity`'s `on_conflict=entity_type,source_record_id` upsert
  (`temporal/src/activities/supabase_core.py`) — the same mechanism this feature reuses to key
  personas by a stable string (`"skeptic"`, `"judge"`, etc.).
- The only existing workflow, `ExtractActionItemsWorkflow`
  (`temporal/src/workflows/meeting_notes/extract_action_items_workflow.py`), calls every activity
  strictly sequentially (`await workflow.execute_activity(...)` one at a time) — there is no
  existing precedent in this repo for concurrent activity fan-out inside a single workflow.
- The existing worker's `activity_executor = ThreadPoolExecutor(max_workers=20)`
  (`temporal/src/worker.py`) already has enough headroom for this feature's maximum fan-out of 5
  concurrent `call_model` activities per round.

## Decision

We seed the 13-row persona roster (12 pickable personas + 1 judge) as `debate_persona` entities via
a single idempotent migration (`supabase/migrations/20260708090000_seed_debate_personas.sql`), not
through a runtime creation path or a new dedicated table. Each row's full data (label, emoji,
flavor, personality, and a first-person `stance_prompt`) is embedded in `entity_versions.data`, and
a debate snapshots the personas it uses at submission time into its own `debate` entity, so later
roster edits never change an already-running or already-completed debate's arguments.

We orchestrate each debate round's persona turns with Temporal's standard `asyncio.gather` pattern
over multiple `workflow.execute_activity(llm.call_model, ...)` calls inside `RunDebateWorkflow`
(`temporal/src/workflows/debate_arena/debate_workflow.py`), with each persona's call wrapped in its
own try/except so one persona's model failure doesn't abort its round's sibling calls. This is the
first concurrent-fan-out workflow in the repo; it is still fully deterministic-safe because the
workflow only orchestrates already-scheduled activity futures, doing no non-deterministic work
itself.

## Consequences

- **Easier:** No new table, no new activity, no new "look up personas by key" round-trip — the
  workflow only ever reads persona data it was handed at submission time. The roster is trivially
  inspectable and diffable in a single migration file.
- **Harder / new obligations:** The roster is migration-only, not editable through the app (see the
  spec's Open Questions); adding or tweaking a persona means a new migration, not a UI action. A
  debate's persona snapshot can go stale relative to a later roster edit — accepted deliberately for
  reproducibility, same audit-trail spirit as SCD2 versioning elsewhere in this template.
- **Trade-off accepted:** Concurrent fan-out means a single flaky `call_model` call must be isolated
  per-persona (caught inside `run_turn`, not left to propagate through `asyncio.gather`) rather than
  relying on the simpler "any activity failure aborts the workflow" pattern the sequential workflow
  uses; this is more orchestration code than the sequential case, but avoids wasting an entire
  round's already-succeeded sibling calls over one bad model response.
- **Follow-up work implied:** if the roster ever needs non-technical, in-app curation, migration-only
  seeding is the wall this feature hits and works around rather than removes — a roster-management
  UI is out of scope per the spec's Non-Goals.

## Alternatives considered

- **A dedicated `debate_personas` table** — rejected: this template's whole modeling approach is the
  generic entity/relationship graph; a bespoke table for one feature's reference data would be the
  first table added outside that model for no functional gain, and would need its own RLS policy
  instead of inheriting the dev policies already granted on `entities`/`entity_versions`.
- **Creating persona entities at runtime (first debate that uses each key) instead of via
  migration** — rejected: makes the roster invisible until first use, complicates the "12 fixed
  personas" guarantee the picker UI depends on, and adds a race if two debates raced to create the
  same persona key concurrently. A migration guarantees all 13 rows exist before the app runs.
- **A "look up personas by key" activity called from the workflow instead of embedding a full
  snapshot in the `debate` entity** — rejected: adds an activity call per debate for no benefit,
  and breaks reproducibility if the roster is edited between submission and workflow execution.
- **Sequential per-persona turns (matching `ExtractActionItemsWorkflow`'s existing pattern) instead
  of concurrent fan-out** — rejected: with up to 5 personas and a 90s model timeout per call, a
  sequential round could take 5x as long per round for no correctness benefit, and the spec's user
  stories require rounds to complete promptly enough that the "Round X of Y" indicator reads as
  live progress, not a multi-minute stall.
- **Letting one persona's `call_model` failure abort the whole round via `asyncio.gather`'s default
  fail-fast behavior** — rejected: would discard every other persona's already-completed turn in
  that round over a single flaky call; per-persona isolation inside `run_turn` was chosen instead.

## Evidence

- `docs/specs/debate-arena.md` — the feature spec this ADR formalizes decisions from (Technical
  Design, Data Model, and API Design sections).
- `supabase/migrations/20251202090000_core_entity_model.sql` — the generic entity/relationship model
  this feature reuses with zero new tables.
- `supabase/migrations/20260708090000_seed_debate_personas.sql` — the migration that seeds the
  13-row persona roster this ADR describes.
- `temporal/src/workflows/meeting_notes/extract_action_items_workflow.py`,
  `temporal/src/worker.py` — the sequential precedent and the worker's thread-pool headroom that
  motivate and support the new concurrent-fan-out pattern.
- `temporal/src/workflows/debate_arena/debate_workflow.py` — the workflow implementing the decision
  described here.
