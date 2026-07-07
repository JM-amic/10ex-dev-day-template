# ADR-0001: Meeting Notes action-item extraction — workflow shape and model hosting

- **Status:** Proposed
- **Date:** 2026-07-07
- **Deciders:** Jonas Muegge (spec, plan, and ADR drafted with Claude Code assistance)
- **Supersedes / Superseded by:** None

## Context

The Meeting Notes → Action Items feature (`docs/specs/meeting-notes-action-items.md`) needs to turn pasted/uploaded meeting notes into structured action items using an LLM, persist them into the existing generic entity schema (`entities`/`entity_versions`/`relationships_v2`), and surface them in the JSON-driven UI engine. Two decisions had to be made: how the workflow is shaped and triggered, and which model host it calls.

Constraints discovered while designing this, all verified against the actual code:
- The JSON-driven engine's `apiCall` action only talks to Supabase tables (`insert`/`update`/`upsert`/`delete`/`rpc`) — there is no generic outbound-HTTP action type (`frontend/src/engine/ActionDispatcher.ts`).
- The Temporal worker (`temporal/src/worker.py`) is a pure worker process with no HTTP server of any kind.
- Supabase Realtime is not wired into the engine's data layer — `useDataSources.ts` only supports pull-based `supabase`/`api`/`static` sources via react-query.
- An Azure OpenAI Responses API client (`temporal/src/llm_client.py::call_azure_responses`) and activity (`temporal/src/activities/llm.py::call_model`) are already wired and configured via `AZURE_OPENAI_*` env vars, landed in commit `5e3310f` ("feat: wire up Azure OpenAI model call for the Temporal worker").
- AWS Bedrock was raised as an alternative model host (the workshop brief frames the deliverable as "your own Bedrock/Azure model"), but no Bedrock client, SDK dependency, or credentials exist anywhere in this template.

## Decision

We use a single Temporal workflow (`ExtractActionItemsWorkflow`) that reads the meeting-notes entity via an activity, marks it `processing`, calls the model in exactly one activity invocation, and persists the extracted action items or a terminal error — all through Temporal activities, not split across separate services or a multi-step saga. The workflow is started by a new, minimal FastAPI trigger endpoint running alongside the existing worker process, invoked from the frontend via a new custom engine action; the frontend polls Supabase for the result rather than subscribing via Realtime.

We host the model call on **Azure OpenAI**, via the existing `call_azure_responses` client and `call_model` activity, using the Responses API's structured-output mode (`json_schema`, `strict: true`) to constrain the model's output to a validated action-item shape.

## Consequences

- **Easier:** No new inter-service protocol beyond one small REST call (frontend → trigger endpoint) plus Temporal's own activity/workflow contracts. Model hosting required zero new integration work since Azure OpenAI was already wired end-to-end.
- **Harder / new obligations:** A new always-running process (the trigger endpoint) needs its own `docker-compose.yml` entry, health/liveness story, and env-var parity with the worker. The frontend must poll, which meant adding a `refetchInterval` concept to the engine's data-source layer that didn't exist before.
- **Trade-off accepted:** Polling has higher latency and more redundant requests than Realtime, but avoids extending the engine's shared data-source layer to support subscriptions — judged not worth it for a workshop-scale, single-user feature.
- **Trade-off accepted:** One model-call activity (not split into smaller sub-activities, e.g. "classify" then "extract") keeps the workflow simple at the cost of coarser retry granularity — any failure means redoing the whole call, not resuming partway through.
- **Follow-up work implied:** if this feature grows beyond the workshop, Realtime support and a generic outbound-HTTP action type for the engine are the two extension points most likely to be needed next, since this feature hit both walls and worked around them rather than removing them.

## Alternatives considered

- **Frontend calls Temporal directly** (a client SDK in the browser) — rejected: exposes Temporal connection details to the client, and there's no browser-safe Temporal client story in this template.
- **Insert-triggers-workflow via a Supabase Database Webhook** — rejected for this pass: would require enabling/configuring webhooks (or `pg_net`) in the local Supabase stack, which isn't set up today. A thin trigger endpoint is smaller, more visible new infrastructure than a webhook whose behavior lives partly inside Postgres configuration.
- **Supabase Realtime for result delivery** — rejected: would require adding subscription support to `useDataSources.ts`, a change to shared infrastructure other pages don't need yet. Polling reuses what already exists.
- **AWS Bedrock as model host** — rejected: no Bedrock client, SDK dependency, or credentials exist in this template. Azure OpenAI is already fully wired (client, activity, env vars, and a working prior commit); adopting Bedrock now would mean building an entire new integration for no functional gain over the already-working path.
- **Splitting extraction into multiple smaller model-call activities** (e.g. a "does this have action items?" call followed by a separate extraction call) — rejected: adds workflow complexity and a second model call per submission, contradicting the spec's non-functional requirement of a single model call per submission.

## Evidence

- `docs/specs/meeting-notes-action-items.md` — the feature spec this ADR formalizes decisions from (Architecture and Non-Functional Requirements sections).
- `temporal/src/llm_client.py`, `temporal/src/activities/llm.py` — existing Azure OpenAI client/activity this decision builds on.
- `temporal/src/worker.py` — confirms the worker is a pure Temporal process, motivating the new trigger endpoint rather than embedding HTTP in the worker.
- `frontend/src/engine/ActionDispatcher.ts`, `frontend/src/engine/useDataSources.ts` — confirms the engine's action/data-source vocabulary that ruled out the rejected alternatives.
- Commit `5e3310f` ("feat: wire up Azure OpenAI model call for the Temporal worker") — evidence the Azure OpenAI path was already working before this decision was made.
