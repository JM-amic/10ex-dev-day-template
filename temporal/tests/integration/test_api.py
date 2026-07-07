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
    fake_client = _make_client(AsyncMock(return_value=MagicMock()))
    with patch.object(api.Client, "connect", new=AsyncMock(return_value=fake_client)):
        with TestClient(api.app) as client:
            resp = client.post(
                "/workflows/extract-action-items", json={"entity_id": "meeting-1"}
            )

    assert resp.status_code == 202
    assert resp.json() == {"workflow_id": "extract-actions-meeting-1", "started": True}


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

    # FastAPI/pydantic validation errors return 422, not 400.
    assert resp.status_code == 422
