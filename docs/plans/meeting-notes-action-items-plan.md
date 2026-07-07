# Plan: Meeting Notes → Action Items — Temporal Workflow + Supporting Wiring

*Tightened after a self-critique pass — see "Critique fixes applied" callouts inline.*

## Context

`docs/specs/meeting-notes-action-items.md` defines the feature: paste/upload meeting notes (text/XML/JSON) → a Temporal workflow calls our Azure OpenAI model to extract action items → results persist to Supabase's generic entity schema → shown next to the source notes. This plan translates that spec into concrete implementation steps, centered on the Temporal workflow (its activities and where the model call sits), which is the core "agentic feature" deliverable. It also corrects three assumptions the spec made that exploration proved wrong:

1. **`supabase_core.py`'s activities are stubs**, not working code — `create_entity`, `update_entity_scd2`, `get_entity`, `create_relationship` just log and return hardcoded mock values. They need real Supabase I/O.
2. **The engine's `custom` action type is defined but never wired up** — `UIEngine.tsx` doesn't pass `customHandlers` into `createActionDispatcher`, so any `{"action": "custom"}` is currently a silent no-op.
3. **No polling/interval support exists** in the engine's data-source layer — `SupabaseDataSource` has no `refetchInterval` field, and `useDataSources.ts` doesn't pass one to react-query.

A self-critique pass on the first draft of this plan found 14 real issues (invalid Temporal SDK usage, a non-idempotent version-increment race, missing timeouts, missing CORS, an incomplete error-handling story, etc.). Every finding is folded into the approach below.

## Recommended Approach

### 1. Temporal workflow (core of this deliverable)

**Shared Supabase REST helper** — `temporal/src/activities/supabase_core.py` gets a small helper used by every activity:
```python
def _headers() -> dict:
    return {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }
```
*(Critique #13: Kong requires `apikey`, PostgREST needs `Authorization` — both are needed, not just one. RLS isn't even enabled on these tables yet, so this is about satisfying Kong/PostgREST, not bypassing RLS.)*

**Real activity implementations**, replacing the mock bodies:

- `create_entity(entity_type, attributes, created_by)`:
  1. `POST {supabase_url}/rest/v1/entities` with header `Prefer: return=representation`, body `{"entity_type": entity_type}` → read back the generated `id`. *(Critique #4: without `return=representation`, PostgREST returns no body and there's no id to chain off.)*
  2. `POST .../entity_versions` with `{"entity_id": id, "version_number": 1, "data": attributes, "is_current": true}`.
  3. Return `EntityResult(entity_id=id, version_id=<from step 2>)`.

- `get_entity(entity_id)` — explicit return contract (the pseudocode consumes a flat dict, so the activity must produce one, not a raw nested PostgREST row): *(Critique #6)*
  1. `GET .../entities?id=eq.{entity_id}&select=id,entity_type,entity_versions(id,version_number,data)&entity_versions.is_current=eq.true`
  2. Flatten to `{"entity_id": ..., "version_id": ..., "version_number": ..., "data": {...}}` and return that dict.

- `update_entity_scd2(entity_id, version_number, attributes, updated_by)` — **note the added `version_number` parameter**. *(Critique #5: recomputing "current + 1" inside the activity on every call is not idempotent under Temporal's default retries — a lost response causes a retry that re-reads a now-stale "current" and tries to insert a duplicate `version_number`, hitting `uq_entity_versions_version` and failing permanently. Instead, the workflow tracks and passes the next version number explicitly, so a retry is a true no-op if it already landed.)*
  1. `POST .../entity_versions` with `{"entity_id": entity_id, "version_number": version_number, "data": attributes, "is_current": true}`.
  2. If the response is `409`/Postgres `23505` (unique violation on `uq_entity_versions_version` or `uq_entity_versions_current`), treat as **already applied** — log and return success rather than raising. This makes the activity idempotent under retry.
  3. The existing `set_entity_version_validity` trigger auto-closes the previous current version — no separate "close old version" call needed.

- `create_relationship(from_entity_id, to_entity_id, relationship_type, attributes)`:
  1. `POST .../relationships_v2` with `{"parent_id": from_entity_id, "child_id": to_entity_id, "relationship_type": relationship_type, "metadata": attributes or {}}`. *(Critique #7: `attributes` maps to the `metadata` column — the first draft dropped it silently.)*

**New workflow** — `temporal/src/workflows/meeting_notes/extract_action_items_workflow.py`, `ExtractActionItemsWorkflow`, following the `ApprovalWorkflow` house style:

```python
ACTIVITY_TIMEOUT = timedelta(seconds=30)      # Supabase REST calls
MODEL_TIMEOUT = timedelta(seconds=90)         # > call_azure_responses' internal 60s httpx timeout
SUPABASE_RETRY = RetryPolicy(maximum_attempts=5)   # bounded — don't retry a real 4xx forever

@dataclass
class ExtractActionItemsRequest:
    entity_id: str

# Root schema must be a JSON object for Azure structured outputs (strict:true rejects a bare array).
ACTION_ITEMS_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "owner": {"type": ["string", "null"]},
                    "due_date": {"type": ["string", "null"]},
                },
                "required": ["description", "owner", "due_date"],
            },
        }
    },
    "required": ["items"],
}

@workflow.defn
class ExtractActionItemsWorkflow:
    @workflow.run
    async def run(self, request: ExtractActionItemsRequest) -> dict:
        entity = await workflow.execute_activity(
            supabase_core.get_entity, args=[request.entity_id],
            start_to_close_timeout=ACTIVITY_TIMEOUT, retry_policy=SUPABASE_RETRY,
        )
        version_number = entity["version_number"]
        data = entity["data"]

        async def _mark(status: str, **extra) -> int:
            nonlocal version_number
            version_number += 1
            await workflow.execute_activity(
                supabase_core.update_entity_scd2,
                args=[request.entity_id, version_number, {**data, "processing_status": status, **extra}, None],
                start_to_close_timeout=ACTIVITY_TIMEOUT, retry_policy=SUPABASE_RETRY,
            )
            return version_number

        await _mark("processing")

        # --- this is where the model call sits: one activity call, wrapped so
        # ANY failure below (model call, JSON parse, persistence) still lands
        # in an "error" status rather than leaving processing_status stuck. ---
        try:
            result = await workflow.execute_activity(
                llm.call_model,
                args=[data["raw_text"], EXTRACTION_SYSTEM_PROMPT, ACTION_ITEMS_SCHEMA],
                start_to_close_timeout=MODEL_TIMEOUT,
            )
            if not result.success:
                await _mark("error", error_message=result.error)
                return {"status": "error", "error": result.error}

            items = json.loads(result.text)["items"]   # schema guarantees the "items" key

            for item in items:
                action_entity = await workflow.execute_activity(
                    supabase_core.create_entity,
                    args=["action_item", {"description": item["description"],
                                           "owner": item["owner"], "due_date": item["due_date"]}, None],
                    start_to_close_timeout=ACTIVITY_TIMEOUT, retry_policy=SUPABASE_RETRY,
                )
                await workflow.execute_activity(
                    supabase_core.create_relationship,
                    args=[request.entity_id, action_entity.entity_id, "meeting_has_action_item", {}],
                    start_to_close_timeout=ACTIVITY_TIMEOUT, retry_policy=SUPABASE_RETRY,
                )

            await _mark("done")
            return {"status": "done", "item_count": len(items)}

        except Exception as exc:  # noqa: BLE001 — deliberately broad: this is the terminal safety net
            await _mark("error", error_message=str(exc))
            return {"status": "error", "error": str(exc)}
```
*(Critique #1, #2, #3 all addressed above: every multi-arg activity call uses `args=[...]`; every call has an explicit `start_to_close_timeout`; Supabase activities get a bounded `retry_policy` so a real (non-transient) failure surfaces instead of retrying forever; the `try/except` wraps the model call through persistence, and the `except` branch itself calls the (idempotent, timeout-bounded) `update_entity_scd2` activity — not arbitrary I/O — so it's valid inside a workflow.)*

Register `ExtractActionItemsWorkflow` in `temporal/src/worker.py`'s `workflows=[...]` list — the activities (`supabase_core.*`, `llm.call_model`) are already registered there.

**`call_model` activity hardening** (`temporal/src/activities/llm.py`): *(Critique #11)* broaden the except clause from `except LLMError` to also catch `httpx.HTTPError`, returning `LLMCallResult(text="", success=False, error=str(exc))` — otherwise a slow/failed HTTP call raises past the activity boundary as an unhandled exception, independent of whatever timeout the workflow sets.

**New trigger endpoint** — `temporal/src/api.py`, thin FastAPI app:
```python
POST /workflows/extract-action-items   { "entity_id": "..." }
```
- Connect the Temporal client **once**, in a `lifespan` handler, stored on `app.state` — not per-request. *(Critique #9)*
- Use a deterministic `workflow_id = f"extract-actions-{entity_id}"`; catch `WorkflowAlreadyStartedError` and return `{"started": false, "already_running": true}` with 202 rather than a 500 — makes double-submit/retry safe. *(Critique #9)*
- Add `CORSMiddleware` allowing the frontend's origin (`http://localhost:3000` in dev) — the browser calls this cross-origin from the Vite dev server. *(Critique #10)*

Add `fastapi`, `uvicorn` to `temporal/pyproject.toml`. New `docker-compose.yml` service `temporal-trigger`: reuses `build: ./temporal`, overrides `command: ["uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8000"]`, adds `ports: ["8000:8000"]`, same env vars as `temporal-worker`.

### 2. Frontend wiring (supporting, so the workflow is reachable/visible)

- **Wire `customHandlers`**: add `customHandlers?: Record<string, CustomActionHandler>` to `UIEngineProps` (`frontend/src/engine/UIEngine.tsx`), pass through into `createActionDispatcher({...})`. The new route explicitly passes it: `<UIEngine page={meetingNotesPage} customHandlers={{ submitMeetingArtifact }} />`. *(Critique #14: no existing route does this today — spelled out explicitly rather than left implicit.)*
- **Add polling**: add `refetchInterval?: number` to `SupabaseDataSource` (`frontend/src/engine/types.ts`), pass it through in `useDataSources.ts`'s `useQueries` config.
- **New env var** `VITE_TRIGGER_URL`, following the existing `VITE_SUPABASE_URL`-style convention, wired through `.env.example` and `docker-compose.yml`. *(Critique #12: the first draft implied a hardcoded `localhost:8000`, breaking the existing configurability pattern.)*
- **New custom handler** `frontend/src/engine/customHandlers/meetingNotes.ts`: `submitMeetingArtifact(payload, context)` — inserts the `meeting_notes` entity/version via the existing `supabase` client singleton (`@/data/supabase`), then `fetch(POST \`${import.meta.env.VITE_TRIGGER_URL}/workflows/extract-action-items\`, {entity_id})`.
- **New `EngineFileInput`** (`frontend/src/components/engine/forms/EngineFileInput.tsx`) for XML/JSON upload, registered in `frontend/src/registry/index.ts`.
- **New page** `frontend/src/pages/meeting-notes.json` + **hand-written route** `frontend/src/routes/meeting-notes.tsx` (TanStack routing requires this — JSON alone doesn't register a URL) + nav link in `__root.tsx`.

## Critical Files

- `temporal/src/activities/supabase_core.py` — stub → real implementation (+ `_headers()` helper)
- `temporal/src/activities/llm.py` — broaden exception handling
- `temporal/src/workflows/meeting_notes/extract_action_items_workflow.py` — new
- `temporal/src/worker.py` — register new workflow
- `temporal/src/api.py` — new trigger endpoint (lifespan-managed client, CORS, idempotent start)
- `temporal/pyproject.toml`, `docker-compose.yml` — new dependencies + service
- `frontend/src/engine/UIEngine.tsx`, `frontend/src/engine/types.ts`, `frontend/src/engine/useDataSources.ts` — small engine additions
- `frontend/src/engine/customHandlers/meetingNotes.ts` — new
- `frontend/src/components/engine/forms/EngineFileInput.tsx` — new
- `frontend/src/pages/meeting-notes.json`, `frontend/src/routes/meeting-notes.tsx` — new
- `.env.example` — add `VITE_TRIGGER_URL`

## Verification

- **Backend, isolated**: `make up`, manually insert a `meeting_notes` entity via Supabase Studio, `curl -X POST localhost:8000/workflows/extract-action-items -d '{"entity_id": "..."}'`, watch the run in Temporal UI (`localhost:8080`), confirm `action_item` entities + `relationships_v2` rows appear in Supabase Studio, confirm `processing_status` reaches `done`.
- **Idempotency check**: fire the same `curl` twice in a row while the first run is still in flight — confirm the second returns `already_running: true` (202) instead of a 500 or a duplicate workflow.
- **Failure-path check**: temporarily point `AZURE_OPENAI_API_KEY` at a bad value, submit, confirm `processing_status` reaches `error` (not stuck at `processing`) with a populated `error_message`.
- **End-to-end**: `npm run dev` in `frontend/`, navigate to `/meeting-notes`, submit each case from the spec's Testing Strategy matrix (plain text, sparse, zero-items, XML, JSON, malformed file, simulated model failure), confirm the UI state matches what the spec defines for each, and confirm a page refresh preserves results.
