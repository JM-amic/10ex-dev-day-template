# Meeting Notes → Action Items Specification

**Status:** Draft
**Owner:** Jonas Muegge
**Created:** 2026-07-07
**Last Updated:** 2026-07-07

## Overview

A user submits a meeting artifact — pasted text, or an uploaded XML/JSON file — through the app's JSON-driven UI. Submitting inserts a `meeting_notes` entity into Supabase via the engine's existing `apiCall: insert` action, then triggers a Temporal workflow via a new thin trigger endpoint. The workflow calls our Azure OpenAI model via the already-wired `call_model` activity to extract action items with owner and due date, and writes each one back to Supabase as its own entity linked to the parent meeting. The page polls and shows the source artifact alongside the extracted checklist.

## Goals

- Let a user paste free-text notes, or upload an XML/JSON file, and get back a structured list of action items.
- Normalize each supported format (text, XML, JSON) into model-ready text input.
- Each action item has a description, an owner (best-effort from the content), and a due date (best-effort; may be null if not stated).
- Action items and the source artifact are persisted in Supabase and visible in the UI after processing.
- The extraction runs as a Temporal workflow that calls our Azure OpenAI model — this is the "real thinking," not client-side parsing.

## Non-Goals

- Editing/deleting individual action items after creation (view-only for this pass).
- Assigning real user accounts as owners — owner is stored as free text, not linked to an auth identity.
- Notifications, reminders, or syncing to an external task tracker.
- Multi-meeting rollups or dashboards.
- Image/photo upload (JPEG, GIF, etc.) — considered and descoped. Supporting it would require confirming vision-model support on the configured Azure OpenAI deployment, a new Supabase Storage bucket, and an extended model-call path — all out of scope for this pass.
- Other file formats beyond text/XML/JSON (e.g. PDF, DOCX, audio) — explicitly out of scope.
- Client-side file preview/annotation tools beyond simply displaying the uploaded artifact as text.

## User Stories

### As someone who just finished a meeting, I want to paste my notes or upload an XML/JSON export and get a list of action items with owners and due dates, so that I don't have to manually reread everything to figure out who's doing what

**Acceptance Criteria:**
- [ ] I can either paste free-text notes or upload a file (XML or JSON).
- [ ] After submitting, I see a loading/processing state — the page doesn't just hang with no feedback.
- [ ] Once processing finishes, I see a list of action items, each showing a description, an owner (or "unassigned" if the notes didn't name one), and a due date (or "no date" if the notes didn't give one).
- [ ] The original artifact stays visible alongside the extracted list, rendered as text, so I can sanity-check the extraction against the source.
- [ ] If the model call fails, or the uploaded file is unparseable, I see a clear error state instead of a silent failure or a broken page.
- [ ] Refreshing the page still shows the same source artifact and action items — they're persisted, not just held in memory.

### Secondary User Stories

None for this pass — see Non-Goals.

## Technical Design

### Architecture

```
┌──────────┐  upload/paste +  ┌──────────────────┐   POST entity_id   ┌──────────────────┐
│ Frontend │  insert entity   │ Supabase          │                    │  Trigger endpoint │
│ (custom  │ ───────────────▶ │  meeting_notes    │                    │  (new, thin)      │
│  action) │                  │  entity/version   │                    └────────┬─────────┘
└────┬─────┘                  └──────────────────┘                             │ starts workflow
     │ polls processing_status                                                  ▼
     │                                                                  ┌──────────────────┐
     │                                                                  │ Temporal Workflow │
     │                                                                  │ (extract-actions) │
     │                                                                  └────────┬─────────┘
     │                                                                            │ calls model
     │                                                                            ▼
     │                                                                  ┌──────────────────┐
     │                                                                  │ Azure OpenAI      │
     │                                                                  │ gpt-5.4           │
     │                                                                  └────────┬─────────┘
     │                                                          persists items   ▼
     └───────────────────────────────────────────────────▶  Supabase (entities / entity_versions / relationships_v2)
```

**Trigger mechanism:** The engine's `apiCall` action only supports `insert`/`update`/`upsert`/`delete`/`rpc` against Supabase tables — no generic "call this endpoint" action exists. A new `submitMeetingArtifact` custom action handler (registered in app setup, invoked via `ActionDispatcher`'s existing `custom` action type) will: (1) insert the `meeting_notes` entity + version, (2) POST the new entity ID to a small new trigger endpoint that starts the Temporal workflow. This needs one new thin HTTP endpoint next to the Temporal worker but zero changes to the engine's core action vocabulary. The worker (`temporal/src/worker.py`) is a pure Temporal worker process today with no HTTP server, so this trigger endpoint is a genuinely new process with its own `docker-compose.yml` entry.

**Result handling:** Supabase Realtime isn't wired into the engine's data-source layer (`useDataSources.ts` only supports `supabase`/`api`/`static` source types, all pull-based via react-query). Rather than extend the engine to support Realtime, the frontend polls the `meeting_notes` entity's `processing_status` on an interval while status is `pending`/`processing`, and stops once it flips to `done`/`error`.

### Data Model

No new bespoke tables — reuses the existing generic entity/relationship schema (`entities`, `entity_versions`, `relationships_v2`), which is SCD2-versioned (a new "version" is always a new row, never an in-place update).

**`meeting_notes` entity** (`entities.entity_type = 'meeting_notes'`), one per submission. `entity_versions.data`:
```json
{
  "input_format": "text | xml | json",
  "raw_text": "the pasted or uploaded content, always stored inline as text",
  "processing_status": "pending | processing | done | error",
  "error_message": "string, populated only when status = error"
}
```
Each status transition (`pending → processing → done`) is a **new** `entity_versions` row per the existing SCD2 trigger — a single submission naturally accumulates 2-3 version rows as it progresses. That's expected audit-trail behavior, not a bug, and it's exactly what the frontend polls `is_current` on.

**`action_item` entity** (`entities.entity_type = 'action_item'`), one per extracted item, created once (view-only, no further versions per the Non-Goals). `entity_versions.data`:
```json
{ "description": "string", "owner": "string | null", "due_date": "ISO date string | null" }
```

**`relationships_v2`**: one row per action item, `relationship_type = 'meeting_has_action_item'`, `parent_id` = the meeting entity, `child_id` = the action item entity.

No Supabase Storage bucket is needed — text, XML, and JSON are all stored inline as `raw_text`.

### API Design

**New trigger endpoint** (thin FastAPI app, new container, shares the worker's `Client.connect`):
```http
POST /workflows/extract-action-items
```
Request:
```json
{ "entity_id": "uuid of the meeting_notes entity" }
```
Response (202 — fire and forget, frontend polls Supabase for status, not this endpoint):
```json
{ "workflow_id": "extract-actions-<entity_id>", "started": true }
```
Errors: `400` if `entity_id` missing/malformed, `502` if it can't reach Temporal.

**`call_model` activity** (`temporal/src/activities/llm.py`) — used as-is, no changes needed: `call_model(input_text, system, json_schema)`.

**No new read endpoint** — the frontend reads `meeting_notes` and `action_item` entities straight from Supabase via the existing `supabase` data source type, same as every other page in this template.

### UI/UX Design

New page, `meeting-notes.json`, following this template's JSON-page convention (as seen in `entity-detail.json`).

```
┌──────────────────────────────────────────────────────────┐
│  Meeting Notes → Action Items                             │
├─────────────────────────────┬──────────────────────────────┤
│  [ Paste text ]  [ Upload file ]   ◀ toggle input mode      │
│  ┌─────────────────────────┐                                │
│  │ <textarea>               │   or   [ Choose File ]         │
│  │                          │        accepted: .xml .json    │
│  └─────────────────────────┘                                 │
│  [ Extract Action Items ]                                    │
├─────────────────────────────┬──────────────────────────────┤
│  Source Artifact             │  Action Items                │
│  (text block)                │  ┌───────────────────────┐   │
│                               │  │ ☐ Description          │   │
│                               │  │   Owner · Due date     │   │
│                               │  └───────────────────────┘   │
│                               │  (repeats, or empty/loading/  │
│                               │   error state below)          │
└───────────────────────────────────────────────────────────┘
```

**States** (all driven by `meeting_notes.entity_versions[0].data.processing_status`, polled per the Architecture decision):
- **Idle** — form only, no artifact/results panel yet.
- **Pending/Processing** — `EngineSkeleton` placeholder where the action-item list will go; source artifact panel already shows what was submitted.
- **Done, items found** — action items rendered via an `each`/`as` list (same pattern as the Version History block in `entity-detail.json`), each showing description, owner (`"unassigned"` fallback), due date (`"no date"` fallback).
- **Done, zero items** — explicit `EngineAlert` "No action items found" — distinct from error.
- **Error** — `EngineAlert variant="destructive"` showing `error_message`, plus a "Try again" button that resubmits the same artifact (new `meeting_notes` entity/version, re-triggers the workflow).

**Interaction details:**
- Toggle between "paste text" and "upload file" swaps which input control is shown; only one is active at submit time.
- Submit button disabled until either the textarea has content or a file is chosen.
- Source artifact always renders as a `<pre>`-style text block preserving whitespace.

## Implementation Plan

### Phase 1: Foundation
- [ ] New `EngineFileInput` form component (`frontend/src/components/engine/forms/`) — file picker for XML/JSON, following the same props/dispatch pattern as `EngineTextarea`.

### Phase 2: Core Workflow
- [ ] New `ExtractActionItems` Temporal workflow: reads the `meeting_notes` entity, calls the model via the existing `call_model` activity, creates one `action_item` entity + `relationships_v2` row per item, updates `meeting_notes` status via `update_entity_scd2` at each stage (pending → processing → done/error).
- [ ] New thin trigger endpoint (FastAPI, new container) that starts the workflow given an `entity_id`; wire into `docker-compose.yml`.
- [ ] `meeting-notes.json` page: submit form (paste or upload), insert `meeting_notes` entity/version, dispatch the new `submitMeetingArtifact` custom action to call the trigger endpoint.

### Phase 3: Polish
- [ ] Polling on the page while `processing_status` is `pending`/`processing`.
- [ ] Empty state ("no action items found") and error state (with retry) per the UI/UX Design section.
- [ ] Source-artifact rendering as a preserved-whitespace text block.

No Phase 4 (Launch) — this is a local, single-developer workshop feature with no staged rollout.

## Testing Strategy

Manual verification only — this template has no automated test suite yet for the worker or frontend (per `AGENTS.md`), and introducing one is out of scope here.

**Manual test matrix:**
- **Text** — plain paste with 2-3 clear action items (owner + due date both stated).
- **Text, sparse** — notes with an action item missing an owner, and one missing a due date — confirms `"unassigned"`/`"no date"` fallbacks.
- **Text, zero action items** — confirms the "no action items found" empty state, not a broken/empty-looking list.
- **XML** — a small structured export (e.g. a fake calendar/meeting-tool XML) — confirms text-format normalization doesn't choke on markup.
- **JSON** — same idea, structured JSON blob.
- **Malformed/unparseable XML or JSON file** — confirms a clear error state, not a hang or crash.
- **Model failure** — simulate by pointing at a bad Azure OpenAI endpoint/key — confirms the error state and retry button work.
- **Persistence check** — after each successful run, refresh the page and confirm the same source artifact and action items still show (reading back from Supabase, not memory).

## Rollout Plan

N/A for this pass — local, single-developer workshop feature. No feature flags, staged rollout, beta group, or external comms.

## Metrics & Success Criteria

Workshop-scale — success is observed directly, not measured statistically:
- Each format in the Testing Strategy matrix (text, XML, JSON) produces a plausible, correctly-shaped action item list, manually verified against the source artifact.
- The full round trip — submit artifact → workflow runs → items appear on screen — completes and is visibly reflected in Supabase (`entities`/`entity_versions`/`relationships_v2`).
- Failure modes (bad model call, malformed file, zero action items) each surface their own distinct, correct UI state rather than collapsing into a generic error or a silent blank screen.

## Dependencies

- **New Python web framework dependency** (e.g. FastAPI + uvicorn) for the trigger endpoint — not currently a dependency of `temporal/`.
- **`docker-compose.yml` changes** — new service for the trigger endpoint, plus whatever env vars it needs (Temporal address, namespace, task queue — same as the worker).
- **Existing wired pieces this builds on, already in place**: `call_model` activity, `supabase_core` activities (`create_entity`, `create_relationship`, `update_entity_scd2`, `get_entity`), the JSON-page engine and its `apiCall`/`custom` action types.

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Workflow crashes/times out mid-run, leaving `processing_status = 'processing'` forever | Medium — page polls indefinitely, looks hung | Medium | Workflow wraps the model call + persistence in a try/except that always writes an `error` status version on failure, even on unexpected exceptions |
| Malformed/unparseable XML or JSON file crashes the workflow instead of erroring cleanly | Medium | Medium | Explicit malformed-file case in the Testing Strategy matrix forces this to be handled before calling it done |
| Model misreads or hallucinates owner/due date from ambiguous notes | Low — acceptable per Non-Goals (no accuracy guarantees) | High | Explicitly out of scope for quality guarantees; source artifact stays visible so the user can sanity-check and mentally discard bad extractions |
| Trigger endpoint is unreachable (new container not started/misconfigured) | Medium — submission silently does nothing beyond the initial insert | Medium | Trigger call failure surfaces as an immediate error state on submit, not just a stuck "processing" spinner — don't let it fail silently |
| `meeting_notes` SCD2 versions accumulate (pending → processing → done each write a new row) and are never cleaned up | Low — minor storage growth, not a correctness issue | High (expected, not really a risk) | Accepted as normal audit-trail behavior for a workshop-scale feature; not worth a cleanup job |

## Open Questions

- [ ] Should the trigger endpoint run as a separate container, or inside the existing worker process as a background HTTP server? — Owner: implementation-time decision, leaning separate container per the Architecture section but not fully committed.
- [ ] Does `EngineFileInput` belong as a permanent addition to the reusable engine component library, or a one-off for this page? — Owner: whoever picks up Phase 1, affects whether it needs the same polish/generality as other engine form components.

## References

- `Generalisable_schema.md` — the entity/relationship schema this feature reuses.
- `temporal/src/llm_client.py`, `temporal/src/activities/llm.py` — existing Azure OpenAI client and activity this builds on.
- `temporal/src/activities/supabase_core.py` — existing entity/relationship CRUD activities the workflow will call.
- `temporal/src/workflows/example/approval_workflow.py` — house style reference for workflow structure (dataclasses, signals/queries).
- `frontend/src/engine/ActionDispatcher.ts`, `frontend/src/pages/entity-detail.json` — engine action vocabulary and JSON-page conventions this feature follows.
- `docs/adrs/TEMPLATE.md` — ADR template, if the trigger-endpoint-placement open question gets formalized.
