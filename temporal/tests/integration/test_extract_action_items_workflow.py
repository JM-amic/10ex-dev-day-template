from __future__ import annotations

import json
import uuid

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.llm import LLMCallResult
from src.activities.supabase_core import EntityResult
from src.workflows.meeting_notes.extract_action_items_workflow import (
    ExtractActionItemsRequest,
    ExtractActionItemsWorkflow,
)

TASK_QUEUE = "test-extract-action-items"


async def _run(env: WorkflowEnvironment, activities, entity_id: str = "meeting-1") -> dict:
    async with Worker(
        env.client,
        task_queue=TASK_QUEUE,
        workflows=[ExtractActionItemsWorkflow],
        activities=activities,
    ):
        return await env.client.execute_workflow(
            ExtractActionItemsWorkflow.run,
            ExtractActionItemsRequest(entity_id=entity_id),
            id=f"wf-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )


async def test_happy_path():
    status_calls: list[str] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": {
                "raw_text": "Alice will ship the report. Bob will book the room.",
                "input_format": "text",
                "processing_status": "pending",
            },
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        status_calls.append(attributes["processing_status"])
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        items = [
            {"description": "ship the report", "owner": "Alice", "due_date": None},
            {"description": "book the room", "owner": "Bob", "due_date": None},
        ]
        return LLMCallResult(text=json.dumps({"items": items}), success=True)

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        return EntityResult(entity_id=f"action-{uuid.uuid4()}", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
        )

    assert result == {"status": "done", "item_count": 2}
    assert status_calls == ["processing", "done"]


async def test_zero_items():
    create_entity_calls: list = []
    create_relationship_calls: list = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": {"raw_text": "Just a status update, no actions.", "processing_status": "pending"},
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        return LLMCallResult(text=json.dumps({"items": []}), success=True)

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        create_entity_calls.append(entity_type)
        return EntityResult(entity_id="should-not-happen", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        create_relationship_calls.append(rel_type)
        return {"relationship_id": "should-not-happen", "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
        )

    assert result == {"status": "done", "item_count": 0}
    assert create_entity_calls == []
    assert create_relationship_calls == []


async def test_model_failure():
    error_calls: list[dict] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": {"raw_text": "notes", "processing_status": "pending"},
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append(attributes)
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        return LLMCallResult(text="", success=False, error="boom")

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        raise AssertionError("create_entity should not be called on model failure")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        raise AssertionError("create_relationship should not be called on model failure")

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
        )

    assert result == {"status": "error", "error": "boom"}
    assert len(error_calls) == 1
    assert error_calls[0]["processing_status"] == "error"
    assert error_calls[0]["error_message"] == "boom"


async def test_activity_exception_path():
    error_calls: list[dict] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": {"raw_text": "notes", "processing_status": "pending"},
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append(attributes)
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        items = [{"description": "do it", "owner": None, "due_date": None}]
        return LLMCallResult(text=json.dumps({"items": items}), success=True)

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        raise ApplicationError("boom", non_retryable=True)

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": "rel-1", "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
        )

    assert result == {"status": "error", "error": "boom"}
    assert len(error_calls) == 1
    assert error_calls[0]["error_message"] == "boom"
