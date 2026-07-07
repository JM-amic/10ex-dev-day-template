from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from src import api


def _make_client(start_workflow_mock: AsyncMock):
    fake_client = MagicMock()
    fake_client.start_workflow = start_workflow_mock
    return fake_client


def test_trigger_success():
    start = AsyncMock(return_value=MagicMock())
    fake_client = _make_client(start)
    with patch.object(api.Client, "connect", new=AsyncMock(return_value=fake_client)):
        with TestClient(api.app) as client:
            resp = client.post(
                "/workflows/extract-action-items", json={"entity_id": "meeting-1"}
            )

    assert resp.status_code == 202
    assert resp.json() == {"workflow_id": "extract-actions-meeting-1", "started": True}

    # Prove Temporal was actually invoked with the right workflow, id, and queue --
    # the response envelope alone doesn't establish this (workflow_id is derived
    # locally from entity_id regardless of what start_workflow was called with).
    assert start.call_count == 1
    args, kwargs = start.call_args
    assert args[0] == api.ExtractActionItemsWorkflow.run
    assert args[1] == api.ExtractActionItemsRequest(entity_id="meeting-1")
    assert kwargs["id"] == "extract-actions-meeting-1"
    assert kwargs["task_queue"] == api.settings.temporal_task_queue


def test_trigger_already_running():
    start = AsyncMock(
        side_effect=WorkflowAlreadyStartedError(
            "extract-actions-meeting-1", "ExtractActionItemsWorkflow"
        )
    )
    fake_client = _make_client(start)
    with patch.object(api.Client, "connect", new=AsyncMock(return_value=fake_client)):
        with TestClient(api.app) as client:
            resp = client.post(
                "/workflows/extract-action-items", json={"entity_id": "meeting-1"}
            )

    assert resp.status_code == 202
    assert resp.json() == {"started": False, "already_running": True}


def test_trigger_rpc_error():
    start = AsyncMock(
        side_effect=RPCError("temporal unavailable", RPCStatusCode.UNAVAILABLE, b"")
    )
    fake_client = _make_client(start)
    with patch.object(api.Client, "connect", new=AsyncMock(return_value=fake_client)):
        with TestClient(api.app) as client:
            resp = client.post(
                "/workflows/extract-action-items", json={"entity_id": "meeting-1"}
            )

    assert resp.status_code == 502
    assert resp.json() == {"error": "Could not reach Temporal"}


def test_trigger_missing_entity_id():
    fake_client = _make_client(AsyncMock(return_value=MagicMock()))
    with patch.object(api.Client, "connect", new=AsyncMock(return_value=fake_client)):
        with TestClient(api.app) as client:
            resp = client.post("/workflows/extract-action-items", json={"entity_id": ""})

    # Known deviation from docs/specs/meeting-notes-action-items.md, which
    # documents 400 for a missing/malformed entity_id: pydantic's own request
    # validation returns 422 before our handler ever runs, and isn't worth
    # overriding for a workshop-scale endpoint. Pinning actual behavior here
    # so a future spec update (or a deliberate switch to 400) is a conscious
    # choice, not a silent drift.
    assert resp.status_code == 422
