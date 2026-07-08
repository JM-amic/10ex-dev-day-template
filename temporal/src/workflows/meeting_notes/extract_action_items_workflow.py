from __future__ import annotations
import json
from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from ...activities import llm, supabase_core

ACTIVITY_TIMEOUT = timedelta(seconds=30)
MODEL_TIMEOUT = timedelta(seconds=90)
SUPABASE_RETRY = RetryPolicy(maximum_attempts=5)
MODEL_RETRY = RetryPolicy(maximum_attempts=3)

EXTRACTION_SYSTEM_PROMPT = (
    "You extract action items from meeting notes. For each action item, identify a clear "
    "description, the owner if named in the notes (otherwise null), and a due date if stated "
    "(as an ISO 8601 date string, otherwise null). Return only items that represent concrete "
    "follow-up actions, not general discussion points."
)

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
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


@dataclass
class ExtractActionItemsRequest:
    entity_id: str


@workflow.defn
class ExtractActionItemsWorkflow:
    @workflow.run
    async def run(self, request: ExtractActionItemsRequest) -> dict:
        # Entities are always created at version_number=1 right before this workflow is
        # triggered (see submitMeetingArtifact), so this is a safe fallback for marking
        # an error if get_entity itself never returns.
        version_number = 1
        data: dict = {}

        async def _mark(status: str, **extra) -> int:
            nonlocal version_number
            version_number += 1
            await workflow.execute_activity(
                supabase_core.update_entity_scd2,
                args=[request.entity_id, version_number, {**data, "processing_status": status, **extra}, None],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )
            return version_number

        try:
            entity = await workflow.execute_activity(
                supabase_core.get_entity,
                args=[request.entity_id],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )
            version_number = entity["version_number"]
            data = entity["data"]

            await _mark("processing")

            result = await workflow.execute_activity(
                llm.call_model,
                args=[data["raw_text"], EXTRACTION_SYSTEM_PROMPT, ACTION_ITEMS_SCHEMA],
                start_to_close_timeout=MODEL_TIMEOUT,
                retry_policy=MODEL_RETRY,
            )
            if not result.success:
                await _mark("error", error_message=result.error)
                return {"status": "error", "error": result.error}

            items = json.loads(result.text)["items"]

            for idx, item in enumerate(items):
                action_entity = await workflow.execute_activity(
                    supabase_core.create_entity,
                    args=[
                        "action_item",
                        {"description": item["description"], "owner": item["owner"], "due_date": item["due_date"]},
                        None,
                        f"{request.entity_id}:action-item:{idx}",
                    ],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=SUPABASE_RETRY,
                )
                await workflow.execute_activity(
                    supabase_core.create_relationship,
                    args=[request.entity_id, action_entity.entity_id, "meeting_has_action_item", {}],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=SUPABASE_RETRY,
                )

            await _mark("done")
            return {"status": "done", "item_count": len(items)}

        except Exception as exc:  # noqa: BLE001 — deliberately broad: terminal safety net
            # Activity failures surface as ActivityError, whose own str() is a generic
            # "Activity task failed" -- the real message is chained onto __cause__.
            message = str(exc.__cause__) if exc.__cause__ else str(exc)
            try:
                await _mark("error", error_message=message)
            except Exception:
                # _mark itself failed -- most likely because `data` (e.g. a huge raw_text)
                # blows past Temporal's payload size limit on the way back out. Fall back to
                # a minimal error record that doesn't require re-sending `data` at all, so an
                # error status always gets written no matter how the failure happened.
                await workflow.execute_activity(
                    supabase_core.update_entity_scd2,
                    args=[request.entity_id, version_number + 1, {"processing_status": "error", "error_message": message}, None],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=SUPABASE_RETRY,
                )
            return {"status": "error", "error": message}
