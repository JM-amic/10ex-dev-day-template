from __future__ import annotations

import json
import re
import uuid

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.llm import LLMCallResult
from src.activities.supabase_core import EntityResult
from src.workflows.debate_arena.debate_workflow import RunDebateRequest, RunDebateWorkflow

TASK_QUEUE = "test-debate-arena"


def _personas(keys):
    return [
        {
            "key": key,
            "label": f"The {key.title()}",
            "emoji": "🙂",
            "personality": "personality text",
            "stance_prompt": "stance prompt text",
        }
        for key in keys
    ]


JUDGE = {
    "key": "judge",
    "label": "The Arbiter Owl",
    "emoji": "🦉",
    "personality": "Calm, impartial.",
    "stance_prompt": "Weigh every argument on its merits.",
}


def _debate_data(personas, round_count=2, topic="Should we ship on Friday?"):
    return {
        "topic": topic,
        "round_count": round_count,
        "selected_personas": personas,
        "judge_persona": JUDGE,
        "processing_status": "pending",
        "current_round": 0,
    }


def _round_from_input(input_text: str) -> int | None:
    match = re.search(r"This is round (\d+) of", input_text)
    return int(match.group(1)) if match else None


async def _run(env: WorkflowEnvironment, activities, entity_id: str = "debate-1") -> dict:
    async with Worker(
        env.client,
        task_queue=TASK_QUEUE,
        workflows=[RunDebateWorkflow],
        activities=activities,
    ):
        return await env.client.execute_workflow(
            RunDebateWorkflow.run,
            RunDebateRequest(entity_id=entity_id),
            id=f"wf-{uuid.uuid4()}",
            task_queue=TASK_QUEUE,
        )


async def test_happy_path():
    personas = _personas(["skeptic", "wizard", "pragmatist"])
    event_log: list[tuple] = []
    create_entity_calls: list[tuple] = []
    create_relationship_calls: list[tuple] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": _debate_data(personas, round_count=2),
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        event_log.append(("mark", attributes["processing_status"], version_number, attributes.get("current_round")))
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        if json_schema and "argument" in json_schema.get("properties", {}):
            round_num = _round_from_input(input_text)
            event_log.append(("call_model_turn", round_num))
            return LLMCallResult(text=json.dumps({"argument": f"argument text round {round_num}"}), success=True)
        event_log.append(("call_model_verdict",))
        return LLMCallResult(
            text=json.dumps({"summary": "summary text", "recommendation": "recommendation text"}),
            success=True,
        )

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        create_entity_calls.append((entity_type, attributes, source_record_id))
        return EntityResult(entity_id=f"entity-{uuid.uuid4()}", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        create_relationship_calls.append((from_id, to_id, rel_type))
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "done", "round_count": 2}

    # Status transitions layered on version_number=1 read from get_entity:
    # round 1 processing (v2), round 2 processing (v3), done (v4).
    marks = [e for e in event_log if e[0] == "mark"]
    assert [(m[1], m[2], m[3]) for m in marks] == [
        ("processing", 2, 1),
        ("processing", 3, 2),
        ("done", 4, 2),
    ]

    # current_round is marked BEFORE that round's call_model activities run.
    round1_mark_idx = event_log.index(("mark", "processing", 2, 1))
    round1_first_call_idx = event_log.index(("call_model_turn", 1))
    assert round1_mark_idx < round1_first_call_idx

    round2_mark_idx = event_log.index(("mark", "processing", 3, 2))
    round2_first_call_idx = event_log.index(("call_model_turn", 2))
    assert round2_mark_idx < round2_first_call_idx
    # And round 2's activities only run after every round-1 turn call has happened.
    round1_call_indices = [i for i, e in enumerate(event_log) if e == ("call_model_turn", 1)]
    assert max(round1_call_indices) < round2_mark_idx

    turn_creates = [c for c in create_entity_calls if c[0] == "debate_turn"]
    assert len(turn_creates) == 6  # 3 personas x 2 rounds
    verdict_creates = [c for c in create_entity_calls if c[0] == "debate_verdict"]
    assert len(verdict_creates) == 1

    seen_source_ids = {c[2] for c in turn_creates}
    expected_source_ids = {
        f"debate-1:turn:{round_number}:{persona['key']}"
        for round_number in (1, 2)
        for persona in personas
    }
    assert seen_source_ids == expected_source_ids

    for entity_type, attributes, source_record_id in turn_creates:
        assert attributes["persona_key"] in {p["key"] for p in personas}
        assert attributes["round_number"] in (1, 2)
        assert attributes["argument"].startswith("argument text round")
        assert attributes["is_placeholder"] is False

    assert verdict_creates[0][1]["persona_key"] == "judge"
    assert verdict_creates[0][1]["summary"] == "summary text"
    assert verdict_creates[0][1]["recommendation"] == "recommendation text"
    assert verdict_creates[0][2] == "debate-1:verdict"

    turn_relationships = [r for r in create_relationship_calls if r[2] == "debate_has_turn"]
    verdict_relationships = [r for r in create_relationship_calls if r[2] == "debate_has_verdict"]
    assert len(turn_relationships) == 6
    assert len(verdict_relationships) == 1
    for from_id, _, _ in turn_relationships + verdict_relationships:
        assert from_id == "debate-1"


async def test_one_persona_failure_isolated_to_its_own_turn():
    personas = _personas(["skeptic", "wizard", "pragmatist"])
    create_entity_calls: list[tuple] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": _debate_data(personas, round_count=2),
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        if json_schema and "argument" in json_schema.get("properties", {}):
            round_num = _round_from_input(input_text)
            if "The Skeptic" in (system or "") and round_num == 1:
                raise ApplicationError("model unavailable", non_retryable=True)
            return LLMCallResult(text=json.dumps({"argument": f"argument text round {round_num}"}), success=True)
        return LLMCallResult(
            text=json.dumps({"summary": "summary text", "recommendation": "recommendation text"}),
            success=True,
        )

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        create_entity_calls.append((entity_type, attributes, source_record_id))
        return EntityResult(entity_id=f"entity-{uuid.uuid4()}", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "done", "round_count": 2}

    turn_creates = [c for c in create_entity_calls if c[0] == "debate_turn"]
    assert len(turn_creates) == 6  # the failing persona still gets a placeholder turn

    failed_turn = next(
        c for c in turn_creates if c[2] == "debate-1:turn:1:skeptic"
    )
    assert "had nothing to say" in failed_turn[1]["argument"]
    assert "model unavailable" in failed_turn[1]["argument"]
    assert failed_turn[1]["is_placeholder"] is True

    # The other two personas' round-1 turns are unaffected.
    unaffected = [c for c in turn_creates if c[2] in ("debate-1:turn:1:wizard", "debate-1:turn:1:pragmatist")]
    assert len(unaffected) == 2
    for _, attributes, _ in unaffected:
        assert "had nothing to say" not in attributes["argument"]
        assert attributes["is_placeholder"] is False

    # The skeptic's round-2 turn succeeds normally (failure was scoped to round 1 only).
    round2_skeptic = next(c for c in turn_creates if c[2] == "debate-1:turn:2:skeptic")
    assert "had nothing to say" not in round2_skeptic[1]["argument"]
    assert round2_skeptic[1]["is_placeholder"] is False

    assert len([c for c in create_entity_calls if c[0] == "debate_verdict"]) == 1


async def test_judge_failure_aborts_debate_without_verdict():
    personas = _personas(["skeptic", "wizard"])
    error_calls: list[dict] = []
    create_entity_calls: list[tuple] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": _debate_data(personas, round_count=1),
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append(attributes)
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        if json_schema and "argument" in json_schema.get("properties", {}):
            return LLMCallResult(text=json.dumps({"argument": "an argument"}), success=True)
        return LLMCallResult(text="", success=False, error="judge model boom")

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        create_entity_calls.append((entity_type, attributes, source_record_id))
        return EntityResult(entity_id=f"entity-{uuid.uuid4()}", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "error", "error": "Judge model call failed: judge model boom"}
    assert len(error_calls) == 1
    assert error_calls[0]["error_message"] == "Judge model call failed: judge model boom"
    assert [c[0] for c in create_entity_calls] == ["debate_turn", "debate_turn"]  # no debate_verdict


async def test_get_entity_failure_still_writes_error_status():
    """Regression test: a get_entity failure (e.g. the entity's data payload exceeds
    Temporal's activity result size limit, or the entity doesn't exist) must not leave
    the debate stuck on 'pending' forever -- an error status has to be written even
    though `data` was never fetched, mirroring the equivalent meeting-notes fix."""
    error_calls: list[dict] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        raise ApplicationError("could not read debate entity", non_retryable=True)

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append({"version_number": version_number, **attributes})
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        raise AssertionError("call_model should not be called")

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        raise AssertionError("create_entity should not be called")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        raise AssertionError("create_relationship should not be called")

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "error", "error": "could not read debate entity"}
    assert len(error_calls) == 1
    assert error_calls[0]["processing_status"] == "error"
    assert error_calls[0]["error_message"] == "could not read debate entity"
    assert error_calls[0]["current_round"] == 0
    # version_number=1 is the entity's initial row; the error write must use a later version.
    assert error_calls[0]["version_number"] > 1


async def test_current_round_preserved_on_error_mid_debate():
    """Regression test: an error after round 2 has started must persist
    current_round=2 on the error record, not revert to the stale current_round=0
    from the entity's initial data (the bug: `_mark("error", ...)` without threading
    the in-flight round number through). `call_model` failures are per-persona
    isolated and never abort the debate, so this forces the abort via a
    `create_entity` failure while persisting a round-2 turn instead.
    """
    personas = _personas(["skeptic", "wizard"])
    error_calls: list[dict] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": _debate_data(personas, round_count=3),
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append(attributes)
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        if json_schema and "argument" in json_schema.get("properties", {}):
            round_num = _round_from_input(input_text)
            return LLMCallResult(text=json.dumps({"argument": f"argument round {round_num}"}), success=True)
        raise AssertionError("judge call_model should not be reached")

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        if attributes.get("round_number") == 2:
            raise ApplicationError("supabase unreachable", non_retryable=True)
        return EntityResult(entity_id=f"entity-{uuid.uuid4()}", version_id="v1")

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "error", "error": "supabase unreachable"}
    assert len(error_calls) == 1
    assert error_calls[0]["current_round"] == 2


async def test_persistence_failure_mid_debate_surfaces_error():
    personas = _personas(["skeptic"])
    error_calls: list[dict] = []

    @activity.defn(name="get_entity")
    async def get_entity(entity_id: str) -> dict:
        return {
            "entity_id": entity_id,
            "version_id": "ver-1",
            "version_number": 1,
            "data": _debate_data(personas, round_count=1),
        }

    @activity.defn(name="update_entity_scd2")
    async def update_entity_scd2(entity_id, version_number, attributes, updated_by):
        if attributes["processing_status"] == "error":
            error_calls.append(attributes)
        return EntityResult(entity_id=entity_id, version_id=f"ver-{version_number}")

    @activity.defn(name="call_model")
    async def call_model(input_text, system=None, json_schema=None) -> LLMCallResult:
        return LLMCallResult(text=json.dumps({"argument": "an argument"}), success=True)

    @activity.defn(name="create_entity")
    async def create_entity(entity_type, attributes, created_by, source_record_id) -> EntityResult:
        raise ApplicationError("supabase unreachable", non_retryable=True)

    @activity.defn(name="create_relationship")
    async def create_relationship(from_id, to_id, rel_type, attributes) -> dict:
        return {"relationship_id": str(uuid.uuid4()), "success": True}

    async with await WorkflowEnvironment.start_time_skipping() as env:
        result = await _run(
            env,
            [get_entity, update_entity_scd2, call_model, create_entity, create_relationship],
            entity_id="debate-1",
        )

    assert result == {"status": "error", "error": "supabase unreachable"}
    assert len(error_calls) == 1
    assert error_calls[0]["error_message"] == "supabase unreachable"
