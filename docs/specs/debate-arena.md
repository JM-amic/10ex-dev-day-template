# Multi-Agent Debate Arena

**Status:** Ready for Build (spec-loop converged after 2 rounds)

---

# Multi-Agent Debate Arena Specification

**Status:** Draft
**Owner:** Unassigned
**Created:** 2026-07-08
**Last Updated:** 2026-07-08

## Overview

A user submits a topic or a decision they're stuck on, picks a round count (2-4), and picks 3-5 debater personas from a fixed roster of 12 (4 "classical" archetypes + 8 "unusual" fantasy/mythology/cartoon-flavored archetypes), each with a genuine argumentative lens, not just flavor text. Submitting inserts a `debate` entity into Supabase (same generic `entities`/`entity_versions` model used by the existing Meeting Notes → Action Items feature) and triggers a new Temporal workflow via the trigger endpoint that already exists at `temporal/src/api.py`. The workflow runs `round_count` rounds: within each round, every selected persona's turn is an Azure OpenAI call (`llm.call_model`, unchanged) fanned out concurrently via `asyncio.gather`, then persisted as its own `debate_turn` entity linked to the debate. Each round's arguments are fed into the next round's prompt as transcript context. After the final round, a fixed judge persona ("The Arbiter Owl") — drawn from the exact same persona-roster mechanism — synthesizes a verdict and a concrete recommendation, persisted as a `debate_verdict` entity. The page polls Supabase the same way `meeting-notes.json` does, so the transcript visibly grows round by round while the workflow runs.

This feature follows the same architecture as Meeting Notes → Action Items end to end: no new tables, the generic entity/relationship SCD2 model, the same trigger-endpoint container (`temporal-trigger`), the same `call_model` activity signature, and the same JSON-driven page engine with polling data sources. The one genuinely new backend pattern is **concurrent activity fan-out within a single workflow round** (this repo's existing workflow, `ExtractActionItemsWorkflow`, is fully sequential); the one genuinely new frontend pattern is a **bespoke persona-picker engine component**, because the JSON page engine's expression language (`frontend/src/engine/ExpressionEvaluator.ts`) has no array method-call support (no `.includes()`, `.filter()`, `.map()`) and no arithmetic operators, so "which of these N roster cards is selected" cannot be expressed as a declarative `{{...}}` binding — the same limitation the existing `meetingNotes.ts` custom handler works around today with a precomputed `pastedTextIsBlank` flag.

## Goals

- Let a user submit a topic, a round count (2-4), and 3-5 personas picked from a fixed 12-persona roster spanning "classical" (optimist, skeptic, pragmatist, contrarian) and "unusual" (wizard, trickster, warrior, villain, hero, detective, scientist, samurai) flavors.
- Every persona (including the judge) carries both a distinct personality *and* a concrete, mappable argumentative stance, defined as data (one row per persona) so the roster is easy to see and tweak without touching workflow code.
- Orchestrate the debate as a Temporal workflow: each persona's turn in a round is an activity; all turns within a round run concurrently; each round's transcript feeds into the next round's prompts.
- After the final round, a fixed judge persona (drawn from the same roster/data mechanism, flavor `judge`) produces a verdict with a concrete recommendation.
- Persist the debate, every turn, and the verdict as linked entities (`debate` → `debate_turn` → `debate_verdict` via `relationships_v2`) so the full transcript is durable and independently queryable.
- The frontend shows the transcript growing live via polling, grouped clearly enough to follow who said what and when, exactly as `meeting-notes.json` already does for action items, including an always-accurate "which round is currently running" indicator (never showing a stale, already-completed round number while the next one is in flight).

## Non-Goals

- Editing, deleting, or re-running individual turns after creation (view-only, same as `action_item` in the meeting-notes feature).
- A persona-roster management UI — the roster is edited via a SQL migration, not through the app. (Open Question below covers whether that's acceptable long-term.)
- Real-time token streaming of a persona's argument as it's generated — turns appear only once a full activity call completes; no partial/typing-indicator UI.
- A history/list page of past debates — a debate is only viewable via its `?entityId=` URL (mirroring meeting notes), no `/debates` index page.
- Cost/rate limiting, model-call budgeting, or a cap on concurrent debates — explicitly out of scope per the feature request ("no hard constraints on LLM usage/cost").
- User accounts, saved/favorited debates, sharing/export (PDF, link-sharing with permissions), or voting/rating on arguments.
- Turn-order variation (e.g., randomizing who speaks first) or persona-to-persona direct rebuttal targeting — every persona in a round responds to the *whole* prior transcript, not to one specific rival.
- Any non-text persona presentation (portrait art, audio/TTS) beyond a static emoji.

## User Stories

### As someone wrestling with a decision, I want to pick a topic, a round count, and a handful of debaters with genuinely different lenses, so I can see the decision argued from multiple angles instead of just getting one model's opinion

**Acceptance Criteria:**
- [ ] I can type a topic/decision into a text field; the submit control is disabled while it's blank (mirroring `pastedTextIsBlank` in `meetingNotes.ts`).
- [ ] I can pick a round count from 2, 3, or 4 rounds via a dropdown, which is pre-selected to 3 by default so the page never has to submit an unset value.
- [ ] I see all 12 pickable personas as cards, each showing its emoji, label, and personality description, visually grouped by "Classical" vs "Unusual" flavor.
- [ ] I can freely mix personas from both flavor groups in one debate (e.g., the skeptic alongside the trickster).
- [ ] The submit control is disabled unless I have 3, 4, or 5 personas selected; selecting a 6th persona has no effect and the picker does not silently exceed 5.
- [ ] After submitting, I see a loading/processing state — the page doesn't hang with no feedback, and the URL updates to include the new debate's `entityId` so refreshing keeps the same debate.
- [ ] As each round completes, new turns appear in the transcript without me refreshing the page (polling), each turn showing the persona's emoji, label, round number, and argument text.
- [ ] While a round is in progress, I see which round is currently running (e.g., "Round 2 of 3") — this number reflects the round actively executing, not the last round that finished, so it never appears stuck one round behind for the ~90s a round's model calls take.
- [ ] After the final round, I see a clearly distinguished verdict block (the judge's emoji/label, summary, and a concrete recommendation) separate from the persona turns.
- [ ] If the workflow fails at any point (model error, unexpected exception), I see a clear error state with the reported message, not a silent hang or a broken page.
- [ ] Refreshing the page still shows the same topic, personas, transcript, and verdict — everything is persisted in Supabase, not held only in memory.

### Secondary User Stories

None for this pass — see Non-Goals.

## Technical Design

### Architecture

```
┌──────────┐  insert debate    ┌──────────────────┐   POST entity_id    ┌───────────────────┐
│ Frontend │  entity/version   │ Supabase          │                     │ temporal-trigger    │
│ (custom  │ ────────────────▶ │  debate           │                     │ (existing FastAPI,  │
│  action) │                   │  entity/version   │                     │  src/api.py)        │
└────┬─────┘                   └──────────────────┘                     └─────────┬──────────┘
     │ polls debate.processing_status,                                            │ starts workflow
     │ debate_turn rows, debate_verdict row                                        ▼
     │                                                                    ┌────────────────────┐
     │                                                                    │ RunDebateWorkflow   │
     │                                                                    │ (new, Temporal)     │
     │                                                                    └────────┬───────────┘
     │                                                                             │ per round: fan out
     │                                                                             │ call_model per persona
     │                                                                             ▼ (asyncio.gather)
     │                                                                    ┌────────────────────┐
     │                                                                    │ Azure OpenAI         │
     │                                                                    │ (llm.call_model,     │
     │                                                                    │  unchanged)          │
     │                                                                    └────────┬───────────┘
     │                                                          persists turns/verdict ▼
     └────────────────────────────────────────────▶  Supabase (entities / entity_versions / relationships_v2)
```

**Trigger mechanism — reused as-is.** `temporal-trigger` (`temporal/src/api.py`, container `temporal-trigger` in `docker-compose.yml`, already running `uvicorn src.api:app`) already proves the "FastAPI trigger endpoint next to the Temporal worker, started by a `custom` action" pattern via `POST /workflows/extract-action-items`. This feature adds a second route, `POST /workflows/start-debate`, on the exact same FastAPI app (no new container, no new `docker-compose.yml` service) — this is a smaller, purely additive change compared to meeting notes, which had to introduce the trigger endpoint from scratch.

**New workflow-orchestration pattern: concurrent fan-out per round.** The only existing workflow, `ExtractActionItemsWorkflow` (`temporal/src/workflows/meeting_notes/extract_action_items_workflow.py`), calls activities strictly sequentially (`await workflow.execute_activity(...)` one at a time). This feature is the first in the repo to fan out multiple concurrent activity calls within one workflow round, via `asyncio.gather` over multiple `workflow.execute_activity(llm.call_model, ...)` calls — a standard, deterministic-safe Temporal Python SDK pattern (the workflow itself is just orchestrating already-scheduled activity futures, not doing non-deterministic work). The existing worker's `activity_executor = ThreadPoolExecutor(max_workers=20)` (`temporal/src/worker.py`) comfortably covers the max fan-out of 5 concurrent `call_model` calls per round.

**Result handling — reused as-is.** Same as meeting notes: Supabase Realtime is not wired into `useDataSources.ts` (only `supabase`/`api`/`static` source types exist, all pull-based via react-query). The frontend polls `debate`, `debate_turn`-linking `relationships_v2` rows, and the `debate_verdict`-linking row on a 2s interval, exactly mirroring `meeting-notes.json`'s `refetchInterval: 2000` pattern (including its precedent of polling `debate_turn`/`debate_verdict` sources indefinitely with no `pollUntilPath`, same as `meeting-notes.json`'s `actionItems` source today).

**New frontend pattern: a persona-picker engine component.** `frontend/src/engine/ExpressionEvaluator.ts`'s `evaluatePath` only supports: ternaries, one comparison operator, `&&`/`||` splits, negation, literals, and `lodash.get` path resolution — no method calls, no arithmetic, no dynamic bracket-index expressions (e.g. `state.selected[item.key]` is not resolvable; lodash `get` would look for a literal property named `item.key`). Reflecting "is this dynamically-fetched roster card currently selected" and enforcing a 3-5 selection count therefore cannot be done with `{{...}}` bindings alone. `EngineFileInput` (`frontend/src/components/engine/forms/EngineFileInput.tsx`) already establishes the precedent of pushing logic the expression language can't express into a real React component that calls `dispatch(onChange, {event: {...}})`; this feature adds a second such component, `EnginePersonaPicker`.

### Data Model

No new tables — reuses `entities`, `entity_versions`, `relationships_v2` (SCD2, per `Generalisable_schema.md` / `DATABASE.md`), the same as meeting notes. Four `entity_type` values are introduced, all via the existing generic schema. `entities.source_record_id` (a real top-level column, already the target of the unique constraint `uq_entities_source (entity_type, source_record_id)` used by `create_entity`'s `on_conflict` upsert in `temporal/src/activities/supabase_core.py`) is used as the persona/debate keying mechanism throughout.

**`debate_persona` entity** — one per roster row, seeded via migration (not created at runtime). `entities.source_record_id` = the persona key (e.g. `"skeptic"`). `entity_versions.data`:
```json
{
  "key": "skeptic",
  "label": "The Skeptic",
  "emoji": "🧐",
  "flavor": "classical",
  "personality": "Dry, unimpressed by hype, demands proof before belief.",
  "stance_prompt": "You argue from a lens of evidence and risk-skepticism. Demand proof, poke holes in optimistic claims, and ask what could go wrong and where the evidence is that this actually works."
}
```
`flavor` is one of `classical | unusual | judge`. The full roster (12 pickable + 1 judge = 13 rows):

| key | label | emoji | flavor | personality | argumentative lens |
|---|---|---|---|---|---|
| optimist | The Optimist | 🌞 | classical | Upbeat, energizing, finds the growth angle. | Upside case: benefits, growth, why it's worth trying. |
| skeptic | The Skeptic | 🧐 | classical | Dry, unimpressed by hype. | Evidence/risk: what could go wrong, where's the proof? |
| pragmatist | The Pragmatist | 🧰 | classical | Grounded, matter-of-fact. | Feasibility/cost: what does execution actually take? |
| contrarian | The Contrarian | 🔄 | classical | Reflexively takes the other side. | Neglected counter-position: stress-tests consensus. |
| wizard | The Sage Wizard | 🧙 | unusual | Measured, weighty, has seen empires fall. | Caution/long-term wisdom: second- and third-order effects. |
| trickster | The Trickster Spirit | 🃏 | unusual | Gleeful, chaotic, loves upending the board. | Risk/disruption: the safe path is the slow death. |
| warrior | The Iron Warrior | ⚔️ | unusual | Blunt, honor-bound, impatient with hesitation. | Decisive action: analysis paralysis is the real enemy. |
| villain | The Shadow Broker | 🦹 | unusual | Smooth, self-interested, three moves ahead. | Incentives/leverage: who actually benefits here? |
| hero | The Wide-Eyed Hero | 🗡️ | unusual | Earnest, idealistic. | Principle/values: what's right, independent of cost? |
| detective | The Rain-Coat Sleuth | 🕵️ | unusual | World-weary, trusts nothing without proof. | Skepticism/evidence: follow the facts, not the story. |
| scientist | The Mad Inventor | 🧪 | unusual | Manic, in love with the experiment itself. | Experimentation: run the test, iterate, failure is data. |
| samurai | The Silent Blade | 🥷 | unusual | Composed, disciplined, speaks little. | Discipline/mastery: do fundamentals right, no shortcuts. |
| judge | The Arbiter Owl | 🦉 | judge | Calm, impartial, synthesizes without ego. | Weighs every argument on its merits, renders a verdict. |

(`stance_prompt` for each row is a fuller first-person system-prompt paragraph built from the "argumentative lens" column above; exact wording is an implementation-time copywriting task, not a blocking decision — the *lens* each persona must argue from is fixed by this table and is what the reviewer/tester checks against.)

**`debate` entity** — one per submission. `entity_versions.data`:
```json
{
  "topic": "string, the user's topic/decision",
  "round_count": 3,
  "selected_personas": [
    { "key": "skeptic", "label": "The Skeptic", "emoji": "🧐", "stance_prompt": "..." }
  ],
  "judge_persona": { "key": "judge", "label": "The Arbiter Owl", "emoji": "🦉", "stance_prompt": "..." },
  "processing_status": "pending | processing | done | error",
  "current_round": 0,
  "error_message": "string, populated only when status = error"
}
```
`selected_personas` and `judge_persona` are full snapshots (not just keys) embedded at submission time by the frontend, which already has the full roster loaded for the picker — see API Design. This is a deliberate design choice: the workflow never needs a new "look up personas by key" activity, and a debate's arguments stay reproducible even if the roster row is edited later (SCD2 audit-trail spirit, same rationale as why `meeting_notes` versions accumulate rather than mutate in place). Like `meeting_notes`, each status transition is a new `entity_versions` row per the existing `trg_entity_versions_scd2` trigger.

**`current_round` semantics (important, since the frontend's progress indicator binds to it directly and the expression language has no arithmetic to adjust it):** `current_round` always holds *the round the workflow is currently working on or has fully finished*, never "the last round that finished, while a new one is silently already running." Concretely, per the API Design workflow shape, the very first thing each round's loop iteration does — before that round's `call_model` activities are even scheduled — is `await _mark("processing", current_round=round_number)`. So the moment round 2 starts executing, `current_round` immediately reads `2`, not `1`. When the debate reaches `status = "done"`, `current_round` equals `round_count`. The frontend can therefore render `"Round {{current_round}} of {{round_count}}"` as a direct, un-computed binding and it is always accurate, including for the entire duration of the round in flight — there is no window where it shows a stale, already-completed round number.

**`debate_turn` entity** — one per persona-turn per round, created once (view-only). `entity_versions.data`:
```json
{
  "round_number": 1,
  "persona_key": "skeptic",
  "persona_label": "The Skeptic",
  "persona_emoji": "🧐",
  "argument": "string, this persona's argument text for this round"
}
```
`entities.source_record_id` = `"{debate_entity_id}:turn:{round_number}:{persona_key}"` (deterministic, mirroring the `"{entity_id}:action-item:{idx}"` pattern in `extract_action_items_workflow.py`, so a Temporal activity retry after a partial failure doesn't double-create the same turn — this relies on `create_entity`'s existing `on_conflict=entity_type,source_record_id` idempotency).

**`debate_verdict` entity** — exactly one per debate, created once. `entity_versions.data`:
```json
{ "persona_key": "judge", "persona_label": "The Arbiter Owl", "persona_emoji": "🦉", "summary": "string", "recommendation": "string" }
```
`source_record_id` = `"{debate_entity_id}:verdict"`.

**`relationships_v2`**: `relationship_type = 'debate_has_turn'` (parent = debate, child = each `debate_turn`) and `relationship_type = 'debate_has_verdict'` (parent = debate, child = the one `debate_verdict`). Both follow the same one-row-per-child pattern as `meeting_has_action_item`.

**New migration** (additive only, per `AGENTS.md`): `supabase/migrations/<timestamp>_seed_debate_personas.sql` — a `do $$ ... $$` block that, for each of the 13 roster rows above, `insert into entities (entity_type, source_record_id) values ('debate_persona', <key>) on conflict (entity_type, source_record_id) do update set updated_at = now() returning id`, then inserts the corresponding `entity_versions` row (`version_number = 1`, `is_current = true`) guarded with `on conflict (entity_id, version_number) do nothing` so the migration is safe to reason about even though `supabase db reset` normally replays every migration against an empty database. No changes to `supabase/seed.sql` (that file stays empty/per-project; the persona roster is core reference data for this feature, not throwaway dev seed data, so it belongs in a migration).

### API Design

**Extended trigger endpoint** (same FastAPI app/container as meeting notes, `temporal/src/api.py`):
```http
POST /workflows/start-debate
```
Request:
```json
{ "entity_id": "uuid of the debate entity" }
```
Response (202):
```json
{ "workflow_id": "start-debate-<entity_id>", "started": true }
```
or, if a workflow with that ID is already running, `{"started": false, "already_running": true}` (reusing the existing `WorkflowAlreadyStartedError` handling already proven by the `extract-action-items` route). Errors: a missing/empty `entity_id` returns **422** (pydantic request-body validation runs before the handler, exactly as the existing `/workflows/extract-action-items` route already behaves per `temporal/tests/integration/test_api.py::test_trigger_missing_entity_id` — not 400; that test file has an explicit comment noting this is a deliberate deviation from what the meeting-notes spec originally documented). `502` if Temporal is unreachable (`RPCError`), matching the existing route.

**New workflow**, `RunDebateWorkflow` (`temporal/src/workflows/debate_arena/debate_workflow.py`), registered in `temporal/src/worker.py`'s `workflows=[...]` list alongside `ApprovalWorkflow` and `ExtractActionItemsWorkflow`, and imported into `api.py` next to `ExtractActionItemsWorkflow`. No new activities: it calls the existing `supabase_core.get_entity`, `supabase_core.update_entity_scd2`, `supabase_core.create_entity`, `supabase_core.create_relationship`, and `llm.call_model` — all already registered in `worker.py`'s `activities=[...]` list.

Workflow shape (mirrors `ExtractActionItemsWorkflow`'s status-transition/try-except skeleton). Note the placement of the `current_round` mark: it happens at the **start** of each round's loop iteration, before that round's activities are scheduled — this is what makes `current_round` always reflect "the round in flight," per the Data Model section above, rather than "the round most recently completed":
```python
@dataclass
class RunDebateRequest:
    entity_id: str

TURN_SCHEMA = {
  "type": "object",
  "properties": {"argument": {"type": "string"}},
  "required": ["argument"], "additionalProperties": False,
}
VERDICT_SCHEMA = {
  "type": "object",
  "properties": {"summary": {"type": "string"}, "recommendation": {"type": "string"}},
  "required": ["summary", "recommendation"], "additionalProperties": False,
}

@workflow.defn
class RunDebateWorkflow:
    @workflow.run
    async def run(self, request: RunDebateRequest) -> dict:
        entity = await workflow.execute_activity(supabase_core.get_entity, args=[request.entity_id], ...)
        data = entity["data"]
        personas = data["selected_personas"]
        judge = data["judge_persona"]
        round_count = data["round_count"]
        # No separate pre-loop "processing" mark: round 1's iteration below performs the
        # pending -> processing transition itself, via the same _mark call every round uses
        # (same nonlocal-version_number pattern as ExtractActionItemsWorkflow).
        try:
            transcript: list[dict] = []
            for round_number in range(1, round_count + 1):
                # Mark BEFORE this round's activities run, so current_round always names the
                # round currently in flight, never a completed-then-stale round number.
                await _mark("processing", current_round=round_number)
                transcript_text = _format_transcript(transcript)  # "Round N — Label: argument" per line

                async def run_turn(persona):
                    system = _persona_system_prompt(persona, data["topic"])
                    input_text = _round_input(data["topic"], transcript_text, round_number, round_count)
                    try:
                        result = await workflow.execute_activity(
                            llm.call_model, args=[input_text, system, TURN_SCHEMA],
                            start_to_close_timeout=MODEL_TIMEOUT, retry_policy=MODEL_RETRY,
                        )
                        if not result.success:
                            return persona, None, result.error
                        return persona, json.loads(result.text)["argument"], None
                    except Exception as exc:  # per-persona isolation: one bad call doesn't sink the round
                        return persona, None, str(exc.__cause__ or exc)

                results = await asyncio.gather(*(run_turn(p) for p in personas))
                for persona, argument, error in results:
                    text = argument if argument is not None else f"[{persona['label']} had nothing to say — model call failed: {error}]"
                    turn_entity = await workflow.execute_activity(
                        supabase_core.create_entity,
                        args=["debate_turn", {"round_number": round_number, "persona_key": persona["key"],
                                               "persona_label": persona["label"], "persona_emoji": persona["emoji"],
                                               "argument": text}, None,
                              f"{request.entity_id}:turn:{round_number}:{persona['key']}"],
                        ...,
                    )
                    await workflow.execute_activity(supabase_core.create_relationship,
                        args=[request.entity_id, turn_entity.entity_id, "debate_has_turn", {}], ...)
                    transcript.append({"round": round_number, "label": persona["label"], "argument": text})

            verdict_result = await workflow.execute_activity(
                llm.call_model, args=[_format_transcript(transcript), _judge_system_prompt(judge, data["topic"]), VERDICT_SCHEMA],
                start_to_close_timeout=MODEL_TIMEOUT, retry_policy=MODEL_RETRY,
            )
            if not verdict_result.success:
                raise RuntimeError(f"Judge model call failed: {verdict_result.error}")
            verdict = json.loads(verdict_result.text)
            verdict_entity = await workflow.execute_activity(
                supabase_core.create_entity,
                args=["debate_verdict", {"persona_key": judge["key"], "persona_label": judge["label"],
                                          "persona_emoji": judge["emoji"], **verdict}, None,
                      f"{request.entity_id}:verdict"],
                ...,
            )
            await workflow.execute_activity(supabase_core.create_relationship,
                args=[request.entity_id, verdict_entity.entity_id, "debate_has_verdict", {}], ...)

            await _mark("done", current_round=round_count)
            return {"status": "done", "round_count": round_count}
        except Exception as exc:
            message = str(exc.__cause__) if exc.__cause__ else str(exc)
            await _mark("error", error_message=message)
            return {"status": "error", "error": message}
```
**Per-persona failure isolation is a deliberate design decision**: unlike `ExtractActionItemsWorkflow` (where any model failure fails the whole run), one persona's `call_model` failing here does not abort the round or the debate — it's recorded as a visible in-transcript placeholder and the debate continues, so a single flaky model call doesn't waste every other persona's already-successful turn in that round. Only a `get_entity` failure, a persistence (`create_entity`/`create_relationship`/`update_entity_scd2`) failure, or the judge's model call failing (there's no persona to isolate it from) aborts the whole debate into `status = "error"`, matching the outer `except Exception` safety net already established by `ExtractActionItemsWorkflow`.

**No new read endpoint** — the frontend reads `debate`, `debate_turn`, and `debate_verdict` entities straight from Supabase via the existing `supabase` data source type, exactly like every other page in this template.

### UI/UX Design

New page, `frontend/src/pages/debate-arena.json`, route `frontend/src/routes/debate-arena.tsx` (URL `/debate-arena?entityId=...`), following the exact same route/page-injection pattern as `meeting-notes.tsx`.

```
┌────────────────────────────────────────────────────────────────────┐
│  Multi-Agent Debate Arena                                          │
├──────────────────────────────────────────────────────────────────────┤
│  Topic: [ <textarea/input> ]                                        │
│  Rounds: [ 2 ▾ 3 ▾ 4 ▾ ]   (defaults to 3)                           │
│  Debaters (pick 3-5):                                                │
│   Classical   🌞 Optimist  🧐 Skeptic  🧰 Pragmatist  🔄 Contrarian │
│   Unusual     🧙 Wizard  🃏 Trickster  ⚔️ Warrior  🦹 Villain        │
│               🗡️ Hero  🕵️ Detective  🧪 Scientist  🥷 Samurai       │
│  [ Start Debate ]  (disabled unless topic set + 3-5 selected)        │
├──────────────────────────────────────────────────────────────────────┤
│  Round 2 of 3 · Status: processing                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 🧐 The Skeptic — Round 1                                       │   │
│  │   "..."                                                         │  │
│  │ 🧙 The Sage Wizard — Round 1                                    │  │
│  │   "..."                                                         │  │
│  │ ... (chronological, grows as polling picks up new turns) ...    │  │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌── Verdict (shown only once processing_status = done) ──────────┐  │
│  │ 🦉 The Arbiter Owl: <summary> / Recommendation: <recommendation>│  │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

**Default page state**, mirroring `meeting-notes.json`'s initial `state` block (`inputMode: "text"`, `pastedText: ""`, `pastedTextIsBlank: true`, etc.):
```json
{
  "topic": "",
  "topicIsBlank": true,
  "roundCount": "3",
  "selectedPersonaKeys": [],
  "selectedPersonaCountValid": false,
  "submittedDebateId": null,
  "submitError": null,
  "isSubmitting": false
}
```
`roundCount` defaults to the string `"3"` (Select components in this engine bind string values) precisely so the dropdown is never left unset — `submitDebate`'s `Number(round_count)` is therefore never called against `undefined`/`NaN`, and a user who never touches the dropdown still submits a valid 3-round debate.

**Data sources** (`debate-arena.json`), following `meeting-notes.json`'s exact polling conventions:
```json
{
  "personas": {
    "type": "supabase", "table": "entities", "select": "*, entity_versions(*)",
    "filters": [
      { "field": "entity_type", "op": "eq", "value": "debate_persona" },
      { "field": "source_record_id", "op": "neq", "value": "judge" },
      { "field": "entity_versions.is_current", "op": "eq", "value": true }
    ]
  },
  "judgePersona": {
    "type": "supabase", "table": "entities", "select": "*, entity_versions(*)",
    "filters": [
      { "field": "entity_type", "op": "eq", "value": "debate_persona" },
      { "field": "source_record_id", "op": "eq", "value": "judge" },
      { "field": "entity_versions.is_current", "op": "eq", "value": true }
    ],
    "single": true
  },
  "debate": {
    "type": "supabase", "table": "entities", "select": "*, entity_versions(*)",
    "filters": [
      { "field": "id", "op": "eq", "value": "{{state.submittedDebateId}}" },
      { "field": "entity_versions.is_current", "op": "eq", "value": true }
    ],
    "single": true, "enabled": "{{state.submittedDebateId}}", "refetchInterval": 2000,
    "pollUntilPath": "entity_versions[0].data.processing_status", "pollUntilValues": ["done", "error"]
  },
  "turns": {
    "type": "supabase", "table": "relationships_v2",
    "select": "child_id, created_at, entities!relationships_v2_child_id_fkey(*, entity_versions(*))",
    "filters": [
      { "field": "parent_id", "op": "eq", "value": "{{state.submittedDebateId}}" },
      { "field": "relationship_type", "op": "eq", "value": "debate_has_turn" }
    ],
    "order": [{ "column": "created_at", "ascending": true }],
    "enabled": "{{state.submittedDebateId}}", "refetchInterval": 2000
  },
  "verdict": {
    "type": "supabase", "table": "relationships_v2",
    "select": "child_id, entities!relationships_v2_child_id_fkey(*, entity_versions(*))",
    "filters": [
      { "field": "parent_id", "op": "eq", "value": "{{state.submittedDebateId}}" },
      { "field": "relationship_type", "op": "eq", "value": "debate_has_verdict" }
    ],
    "enabled": "{{state.submittedDebateId}}", "refetchInterval": 2000
  }
}
```
`turns` are ordered by `relationships_v2.created_at` (a real top-level column) rather than by any embedded JSONB field, because the workflow persists each round's turns strictly in roster order right after that round's `asyncio.gather` resolves, so insertion order already equals round order, then persona order within a round — no additional grouping logic is required for a correct chronological read. `judgePersona` uses the identical `debate_persona`/`entity_versions` shape as `personas`, just filtered to `source_record_id = 'judge'` and marked `single: true`, so `context.data.judgePersona` in `submitDebate` (below) resolves to one row, not an array — this is the fifth and last data source the page needs; there is no separate lookup activity or endpoint involved.

**New engine component**, `EnginePersonaPicker` (`frontend/src/components/engine/forms/EnginePersonaPicker.tsx`), registered in `frontend/src/registry/index.ts` and re-exported from `frontend/src/components/engine/index.ts`, following the exact prop-and-`useUIEngine().dispatch` shape as `EngineFileInput`/`EngineCheckbox`:
```ts
interface EnginePersonaPickerProps extends EngineComponentProps {
  personas: unknown[];       // {{data.personas}} — full roster rows (entities + entity_versions)
  selectedKeys: string[];    // {{state.selectedPersonaKeys}}
  min?: number;              // default 3
  max?: number;              // default 5
  onChange?: ActionDefinition;
}
```
Internally: groups `personas` by `entity_versions[0].data.flavor` (plain JS `.filter`, real code — not a page-JSON expression) into "Classical" and "Unusual" sections, each rendered as a grid of cards (emoji, label, personality, a checked/unchecked visual state). Clicking a card toggles its key in a local copy of `selectedKeys`; once `max` are selected, unselected cards render disabled (no-op on click) rather than allowing a 6th. On every toggle it calls `dispatch(onChange, { event: { selectedKeys: nextKeys, isValidCount: nextKeys.length >= min && nextKeys.length <= max } })`. The JSON page binds `onChange` to a `sequence` of two `setState` actions (`selectedPersonaKeys` and `selectedPersonaCountValid`) — pushing the derived boolean out of the picker rather than recomputing `state.selectedPersonaKeys.length >= 3 && ... <= 5` inline, because `ExpressionEvaluator`'s comparison-then-`||`-then-`&&` parsing order is not reliable for compound conditions mixing both operators in one string (the top-level comparison regex matches greedily before any `||`/`&&` split happens), the same category of limitation that already forced `pastedTextIsBlank` to be precomputed in `meetingNotes.ts` rather than expressed inline.

**New custom action handler**, `frontend/src/engine/customHandlers/debateArena.ts`, mirroring `meetingNotes.ts`'s `submitMeetingArtifact` structure:
```ts
export function updateTopic(payload, context) {
  const text = typeof payload === 'string' ? payload : '';
  context.setState?.('topic', text);
  context.setState?.('topicIsBlank', text.trim().length === 0);
}

export async function submitDebate(payload, context) {
  // payload: { round_count: string }  (from the Select's onChange-bound state; defaults to "3")
  const { round_count } = payload as { round_count: string };
  const selectedKeys = (context.state.selectedPersonaKeys as string[]) || [];
  const personaRows = (context.data.personas as any[]) || [];
  const judgeRow = context.data.judgePersona as any;

  const selected_personas = personaRows
    .filter((p) => selectedKeys.includes(p.entity_versions[0].data.key))
    .map((p) => p.entity_versions[0].data);
  const judge_persona = judgeRow?.entity_versions[0].data;

  // insert `entities` row (entity_type: 'debate'), then `entity_versions` row
  // { topic, round_count: Number(round_count), selected_personas, judge_persona,
  //   processing_status: 'pending', current_round: 0 }
  // then POST { entity_id } to `${VITE_TRIGGER_URL}/workflows/start-debate`
  // then setState('submittedDebateId', entityId) + history.replaceState(?entityId=...)
  // — identical control flow/error handling to submitMeetingArtifact.
}
```

**States**, driven by `data.debate.entity_versions[0].data.processing_status` polled per the Architecture section, mirroring `meeting-notes.json`'s state machine:
- **Idle** — form only.
- **Pending/Processing** — `"Round {{data.debate.entity_versions[0].data.current_round}} of {{data.debate.entity_versions[0].data.round_count}}"` bound directly (no arithmetic needed — see the Data Model's `current_round` semantics note: the workflow marks the round-in-flight *before* running it, so this binding is always accurate, never one round behind) plus already-arrived turns (via the `turns` source) rendered live; an `EngineSkeleton` shown only until the first turn arrives.
- **Done** — full transcript plus the verdict block (`EngineAlert` or `Card` showing the judge's emoji/label/summary/recommendation).
- **Error** — `EngineAlert variant="destructive"` with `error_message`, plus a "Try again" button that resubmits the same topic/round_count/selectedPersonaKeys as a brand-new `debate` entity (identical retry semantics to meeting notes' "Try again").

## Implementation Plan

### Phase 1: Persona roster as data
- [ ] New migration `supabase/migrations/<timestamp>_seed_debate_personas.sql` inserting all 13 `debate_persona` rows (12 pickable + judge) per the Data Model table, idempotent via `on conflict (entity_type, source_record_id)`.
- [ ] Verify via `supabase db reset --config supabase/config.toml` that all 13 rows exist with the correct `flavor` values.
- [ ] Write ADR `docs/adrs/0002-debate-arena-persona-data-and-concurrent-fanout.md` documenting the two new architectural patterns this feature introduces (roster-as-seeded-entities, and concurrent per-round activity fan-out), per the ADR-gate in `docs/adrs/README.md`.

### Phase 2: Backend workflow
- [ ] New `RunDebateWorkflow` (`temporal/src/workflows/debate_arena/debate_workflow.py`) implementing the round loop, concurrent fan-out, per-persona failure isolation, and judge verdict, per the API Design section — no new activities. `current_round` is marked at the *start* of each round's loop iteration (before that round's activities are scheduled), per the API Design pseudocode, not after.
- [ ] Register `RunDebateWorkflow` in `temporal/src/worker.py`'s `workflows=[...]`.
- [ ] New route `POST /workflows/start-debate` in `temporal/src/api.py`, mirroring `extract_action_items`'s body model, success/already-running/RPC-error handling.
- [ ] Integration tests in `temporal/tests/integration/test_debate_workflow.py` (see Testing Strategy) using `WorkflowEnvironment.start_time_skipping()` per the existing `test_extract_action_items_workflow.py` pattern.
- [ ] Extend `temporal/tests/integration/test_api.py` with success/already-running/RPC-error/422 cases for `/workflows/start-debate`, mirroring the existing `extract-action-items` test cases.

### Phase 3: Frontend persona picker
- [ ] New `EnginePersonaPicker` component (`frontend/src/components/engine/forms/EnginePersonaPicker.tsx`) per the UI/UX Design section — flavor grouping, min/max enforcement, `onChange` event shape.
- [ ] Register it in `frontend/src/registry/index.ts` and export it from `frontend/src/components/engine/index.ts`.
- [ ] Component-level vitest coverage for selection toggling, the max-5 disable behavior, and the `isValidCount` calculation.

### Phase 4: Frontend page + submission flow
- [ ] `frontend/src/engine/customHandlers/debateArena.ts` (`updateTopic`, `submitDebate`) per the UI/UX Design section.
- [ ] `frontend/src/engine/customHandlers/__tests__/debateArena.test.ts` mirroring `meetingNotes.test.ts`'s mocked-Supabase/mocked-`fetch` structure — success path, entity-insert failure, version-insert failure, trigger-endpoint failure, and building `selected_personas`/`judge_persona` correctly from `context.data`.
- [ ] `frontend/src/pages/debate-arena.json` (default state block including `roundCount: "3"`, the five data sources — `personas`, `judgePersona`, `debate`, `turns`, `verdict` — the submission form, transcript/verdict display) and `frontend/src/routes/debate-arena.tsx` (mirroring `meeting-notes.tsx`'s `entityId`-from-URL bootstrapping).
- [ ] Add a nav entry/link to the new page in `frontend/src/routes/__root.tsx`'s `Sidebar` component (same place the existing `/meeting-notes` link is defined, ~line 59).

### Phase 5: Polish
- [ ] "Round X of Y" progress text and per-round skeleton while `processing_status = 'processing'`.
- [ ] Per-persona-failure placeholder text rendering distinctly (e.g. muted/italic) in the transcript so a degraded turn is visually obvious, not indistinguishable from a real argument.
- [ ] Error state + retry button per the UI/UX Design section.

No Phase 6 (Launch) — this is a local, single-developer dev-day demo feature with no staged rollout, same as meeting notes.

## Testing Strategy

This repo has real automated test suites on both sides (`frontend`: vitest, per `frontend/package.json`'s `"test": "vitest run"` and the existing `meetingNotes.test.ts`/`confetti.test.ts`; `temporal`: pytest + `pytest-asyncio` + Temporal's `WorkflowEnvironment`, per `temporal/pyproject.toml` and the existing `test_extract_action_items_workflow.py`/`test_api.py`) — both should be extended, not skipped.

**Temporal workflow (`temporal/tests/integration/test_debate_workflow.py`)**, using `WorkflowEnvironment.start_time_skipping()` with fake `activity.defn` stand-ins for `get_entity`/`update_entity_scd2`/`call_model`/`create_entity`/`create_relationship`, mirroring `test_extract_action_items_workflow.py`'s structure:
- Happy path: 3 personas × 2 rounds → 6 `debate_turn` creates + 1 `debate_verdict` create, correct `round_number`/`persona_key` on each, final status `done`.
- `current_round` is asserted to be set to `round_number` via `update_entity_scd2` *before* that round's `call_model` calls are invoked (assert call ordering on the fake activities), so a workflow paused/inspected mid-round always shows the round in flight, not the previous one.
- One persona's `call_model` call fails in round 1 → that persona still gets a `debate_turn` row (the placeholder text), the other personas' turns are unaffected, the debate still reaches `done`.
- The judge's `call_model` call fails → debate ends in `status = "error"`, no `debate_verdict` created.
- `get_entity` (or any persistence activity) raises → debate ends in `status = "error"` with the underlying message surfaced, per the existing `exc.__cause__` unwrapping pattern.
- Deterministic `source_record_id`s per turn (`"{entity_id}:turn:{round}:{persona_key}"`) so idempotent retries don't double-create.

**Trigger endpoint (`temporal/tests/integration/test_api.py`)**: success (202 + correct `workflow_id`/args), already-running (202 + `already_running: true`), Temporal unreachable (502), missing `entity_id` (422 — matching the already-proven actual behavior, not the 400 originally assumed for meeting notes).

**Frontend (`frontend/src/engine/customHandlers/__tests__/debateArena.test.ts`)**: mocked `@/data/supabase` + mocked global `fetch`, mirroring `meetingNotes.test.ts` — successful submit (entity+version insert, correct trigger POST body, `submittedDebateId` set, URL updated), entity-insert failure, version-insert failure, trigger-endpoint non-2xx failure, and that `selected_personas`/`judge_persona` are built correctly from a fixture `context.data.personas`/`context.data.judgePersona`, and that a submit with `context.state.roundCount` left at its `"3"` default sends `round_count: 3` (not `NaN`).

**Frontend component tests** for `EnginePersonaPicker`: renders 12 cards grouped into Classical/Unusual by `flavor`; toggling below `max` calls `onChange` with the updated array and correct `isValidCount`; a 6th selection when already at 5 is a no-op (dispatch not called, or called with the same 5).

**Manual test matrix** (workshop-scale, same rationale as meeting notes — this template has no CI gate beyond these suites):
- 3 personas, 2 rounds — confirm concurrent fan-out actually completes a round before the next round's prompts are built (i.e., round 2 arguments visibly react to round 1 content), and that the "Round X of Y" text flips to the next round's number the instant that round starts, not after it finishes.
- 5 personas, 4 rounds — confirm no timeout/throttling issues at max fan-out × max rounds.
- Mixed-flavor selection (e.g., skeptic + trickster + wizard) — confirm genuinely different argumentative angles in the output, not just different personality flavor text.
- Simulated model failure (bad Azure OpenAI key) mid-debate — confirm the placeholder-turn behavior for a single persona, and the full-error behavior for a judge failure.
- Persistence check — refresh mid-debate and after completion, confirm the same transcript/verdict reload from Supabase.

## Rollout Plan

N/A — local, single-developer dev-day demo feature, same as meeting notes. No feature flags, staged rollout, or external comms.

## Metrics & Success Criteria

Workshop-scale — success is observed directly:
- A submitted debate with 3-5 mixed-flavor personas and 2-4 rounds runs to completion, visibly producing one `debate_turn` per persona per round and exactly one `debate_verdict`, all reflected in Supabase (`entities`/`entity_versions`/`relationships_v2`).
- Manually reading the transcript, each persona's arguments are recognizably arguing from their assigned lens (e.g. the pragmatist talks cost/feasibility, the trickster pushes disruption) — not interchangeable flavor text.
- The transcript visibly grows round-by-round while polling, without a page refresh, and the "Round X of Y" indicator always names the round currently executing.
- A single persona's model-call failure degrades gracefully (placeholder turn, debate continues) rather than discarding an entire round's already-completed sibling turns.
- The judge's verdict references specific arguments from the transcript and states a concrete recommendation, not a generic non-answer.

## Dependencies

- **Existing wired pieces this builds on, unchanged**: `llm.call_model` activity and `llm_client.call_azure_responses` (`temporal/src/activities/llm.py`, `temporal/src/llm_client.py`); `supabase_core.get_entity` / `update_entity_scd2` / `create_entity` / `create_relationship`; `temporal-trigger` FastAPI container and its `Client.connect` lifespan; the JSON-page engine's `custom` action type, `supabase` data source type with `refetchInterval`/`pollUntilPath`, and permissive dev RLS policies on `entities`/`entity_versions`/`relationships_v2` (`supabase/migrations/20260707103039_enable_rls_dev_policies.sql`).
- **New within this feature, no external dependency additions**: one migration, one workflow file, one FastAPI route, one engine component, one custom-handler file, one page/route pair. No new Python or npm packages — `asyncio` (stdlib) is all `RunDebateWorkflow` needs for fan-out.
- **Azure OpenAI concurrency**: running up to 5 concurrent `call_model` calls per round assumes the configured Azure OpenAI deployment's rate limit (TPM/RPM) tolerates that burst; this is an operational assumption, not a code dependency, and is explicitly out of scope to engineer around per the feature request's "no hard constraints on LLM usage/cost."

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| A persona's `call_model` call fails inside `asyncio.gather` and (without care) aborts the whole round, discarding already-succeeded sibling calls in that gather batch | Medium — one flaky model call could waste an entire round for every other persona | Medium | `run_turn` catches its own exceptions and returns a per-persona result instead of letting `gather` propagate; the round always persists all N turns (real or placeholder) — see API Design |
| Workflow crashes/times out mid-round, leaving `processing_status = 'processing'` forever | Medium — page polls indefinitely, looks hung | Medium | Same outer try/except-then-`_mark("error", ...)` safety net as `ExtractActionItemsWorkflow`, proven in `test_extract_action_items_workflow.py::test_activity_exception_path` |
| `current_round` marked at the wrong point in the round loop (e.g., after a round instead of before) makes the "Round X of Y" indicator show a stale, already-completed round number for the full duration of the next round's model calls — exactly the "looks hung" failure mode this feature must avoid | Medium — misleading progress UI reads as broken even though the workflow is healthy | Low, now that it's pinned down | `_mark("processing", current_round=round_number)` is explicitly specified to run at the *start* of each loop iteration, before that round's activities are scheduled (see Data Model's `current_round` semantics note and the API Design pseudocode); covered by an explicit call-ordering assertion in `test_debate_workflow.py` |
| Model returns JSON that doesn't parse or doesn't match `TURN_SCHEMA`/`VERDICT_SCHEMA` despite `strict: true` structured output | Low-Medium | Low | `json.loads(...)["argument"]` failures are caught by the same per-turn/outer exception handling as above, not left to crash the activity uncaught |
| The engine's expression language can't express "is this dynamically-fetched card selected", compound length-range conditions, or arithmetic, forcing logic into a bespoke component and precomputed state flags | Low — adds a small amount of engine surface area | High (definite, not probabilistic) | Documented explicitly in UI/UX Design with the exact precedent (`pastedTextIsBlank`) this mirrors, so the pattern is a conscious choice, not a workaround discovered mid-implementation |
| A `debate`'s `selected_personas`/`judge_persona` snapshot goes stale relative to a later roster-migration edit (label/stance_prompt wording changes) | Low — old debates keep old wording | High (expected, not really a risk) | Deliberate design choice for reproducibility, documented in the Data Model section, same audit-trail spirit as SCD2 versioning elsewhere in this template |
| 5 personas × up to 4 rounds × up to 90s `MODEL_TIMEOUT` per call means a full debate can legitimately take several minutes even with concurrency (rounds are still sequential) | Low — acceptable for a demo, but could read as "broken/slow" without feedback | Medium | "Round X of Y" progress text updated at the start of every round (not after), plus turns appearing live within a round as polling picks them up |
| Judge or persona output is glib/generic rather than substantively tied to the transcript (LLM quality risk) | Low — acceptable per Non-Goals (no accuracy guarantees) | Medium | Full transcript stays visible so the user can sanity-check the verdict against the actual arguments, same rationale as meeting notes' owner/due-date risk |

## Open Questions

- [ ] Should the persona roster ever need in-app editing (vs. migration-only), e.g. for a future non-technical roster curator? — Owner: product, non-blocking; migration-only is sufficient for a dev-day demo and doesn't block Phase 1-5.
- [ ] Should a persona's turn be allowed to explicitly rebut a *specific* rival's prior argument (vs. responding to the whole transcript undifferentiated), for a more pointed debate? — Owner: implementation-time/product-taste decision; the current "respond to the whole transcript" design is simpler and already substantively different per persona per the Data Model's lens table, so this is a possible future enhancement, not a blocker.
- [ ] Should turns be visually grouped/collapsed by round (e.g. an accordion per round) rather than one flat chronological list? — Owner: whoever picks up Phase 4/5; flat chronological list (round number shown per turn) is sufficient for correctness and is what's specified, grouping is a polish nice-to-have.

## References

- `docs/specs/meeting-notes-action-items.md` — the house-style precedent this feature mirrors end to end (trigger endpoint, workflow status-transition/try-except pattern, polling data sources, JSON-page conventions).
- `Generalisable_schema.md`, `DATABASE.md` — the entity/relationship/SCD2 schema this feature reuses with zero new tables.
- `temporal/src/workflows/meeting_notes/extract_action_items_workflow.py` — the sequential status-transition/try-except pattern `RunDebateWorkflow` extends with concurrent fan-out.
- `temporal/src/activities/supabase_core.py`, `temporal/src/activities/llm.py`, `temporal/src/llm_client.py` — existing activities/client reused unchanged.
- `temporal/src/api.py`, `temporal/src/worker.py`, `docker-compose.yml` (`temporal-trigger` service) — existing trigger-endpoint infrastructure extended with one new route.
- `frontend/src/pages/meeting-notes.json`, `frontend/src/routes/meeting-notes.tsx`, `frontend/src/engine/customHandlers/meetingNotes.ts` — the JSON-page/custom-handler pattern `debate-arena.json`/`debateArena.ts` mirrors.
- `frontend/src/components/engine/forms/EngineFileInput.tsx`, `frontend/src/engine/ExpressionEvaluator.ts` — the precedent and the concrete expression-language limitation motivating the new `EnginePersonaPicker` component.
- `frontend/src/routes/__root.tsx` — the `Sidebar` component (existing `/meeting-notes` nav link) that gains the new `/debate-arena` entry.
- `temporal/tests/integration/test_extract_action_items_workflow.py`, `temporal/tests/integration/test_api.py`, `frontend/src/engine/customHandlers/__tests__/meetingNotes.test.ts` — existing test patterns this feature's tests extend.
- `docs/adrs/README.md`, `docs/adrs/0001-meeting-notes-workflow-shape-and-model-hosting.md` — ADR process and precedent; this feature adds ADR-0002 per Phase 1.
