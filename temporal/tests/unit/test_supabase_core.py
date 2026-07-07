from __future__ import annotations

import httpx
import pytest
import respx

from src.activities import supabase_core
from src.config import settings

BASE = settings.supabase_url


@respx.mock
def test_create_entity_normal_path():
    entities = respx.post(f"{BASE}/rest/v1/entities").mock(
        return_value=httpx.Response(201, json=[{"id": "ent-1"}])
    )
    versions = respx.post(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(201, json=[{"id": "ver-1"}])
    )

    result = supabase_core.create_entity("meeting_note", {"raw_text": "hi"})

    assert result == supabase_core.EntityResult(entity_id="ent-1", version_id="ver-1")
    assert entities.called
    assert versions.called
    # No source_record_id -> plain entities insert with entity_type only.
    entity_request = entities.calls.last.request
    assert "on_conflict" not in str(entity_request.url)
    import json

    assert json.loads(entity_request.content) == {"entity_type": "meeting_note"}


@respx.mock
def test_create_entity_with_source_record_id():
    entities = respx.post(f"{BASE}/rest/v1/entities").mock(
        return_value=httpx.Response(201, json=[{"id": "ent-2"}])
    )
    respx.post(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(201, json=[{"id": "ver-2"}])
    )

    result = supabase_core.create_entity(
        "action_item", {"description": "do it"}, source_record_id="meeting:action-item:0"
    )

    assert result == supabase_core.EntityResult(entity_id="ent-2", version_id="ver-2")
    request = entities.calls.last.request
    assert "on_conflict=entity_type,source_record_id" in str(request.url)
    assert request.headers["Prefer"] == "return=representation,resolution=merge-duplicates"
    import json

    assert json.loads(request.content) == {
        "entity_type": "action_item",
        "source_record_id": "meeting:action-item:0",
    }


@respx.mock
def test_create_entity_idempotent_version_conflict():
    respx.post(f"{BASE}/rest/v1/entities").mock(
        return_value=httpx.Response(201, json=[{"id": "ent-3"}])
    )
    respx.post(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(409, json={"code": "23505", "message": "duplicate key"})
    )
    fallback = respx.get(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(200, json=[{"id": "ver-existing"}])
    )

    result = supabase_core.create_entity("meeting_note", {"raw_text": "hi"})

    assert result == supabase_core.EntityResult(entity_id="ent-3", version_id="ver-existing")
    assert fallback.called
    fallback_request = fallback.calls.last.request
    assert "entity_id=eq.ent-3" in str(fallback_request.url)
    assert "version_number=eq.1" in str(fallback_request.url)


@respx.mock
def test_update_entity_scd2_normal_path():
    versions = respx.post(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(201, json=[{"id": "ver-10"}])
    )

    result = supabase_core.update_entity_scd2("ent-1", 2, {"processing_status": "processing"})

    assert result == supabase_core.EntityResult(entity_id="ent-1", version_id="ver-10")
    import json

    body = json.loads(versions.calls.last.request.content)
    assert body["entity_id"] == "ent-1"
    assert body["version_number"] == 2
    assert body["is_current"] is True


@respx.mock
def test_update_entity_scd2_idempotent_conflict():
    respx.post(f"{BASE}/rest/v1/entity_versions").mock(
        return_value=httpx.Response(409, json={"code": "23505", "message": "duplicate key"})
    )

    result = supabase_core.update_entity_scd2("ent-1", 2, {"processing_status": "processing"})

    assert result == supabase_core.EntityResult(entity_id="ent-1", version_id="", success=True)


@respx.mock
def test_get_entity_flattens_nested_response():
    respx.get(f"{BASE}/rest/v1/entities").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "ent-1",
                    "entity_type": "meeting_note",
                    "entity_versions": [
                        {
                            "id": "ver-1",
                            "version_number": 3,
                            "data": {"raw_text": "notes", "processing_status": "pending"},
                        }
                    ],
                }
            ],
        )
    )

    result = supabase_core.get_entity("ent-1")

    assert result == {
        "entity_id": "ent-1",
        "version_id": "ver-1",
        "version_number": 3,
        "data": {"raw_text": "notes", "processing_status": "pending"},
    }


@respx.mock
def test_create_relationship_normal_path():
    rel = respx.post(f"{BASE}/rest/v1/relationships_v2").mock(
        return_value=httpx.Response(201, json=[{"id": "rel-1"}])
    )

    result = supabase_core.create_relationship("ent-1", "ent-2", "meeting_has_action_item", {})

    assert result == {"relationship_id": "rel-1", "success": True}
    import json

    body = json.loads(rel.calls.last.request.content)
    assert body["parent_id"] == "ent-1"
    assert body["child_id"] == "ent-2"
    assert body["relationship_type"] == "meeting_has_action_item"


@respx.mock
def test_create_relationship_idempotent_conflict():
    respx.post(f"{BASE}/rest/v1/relationships_v2").mock(
        return_value=httpx.Response(409, json={"code": "23505", "message": "duplicate key"})
    )
    fallback = respx.get(f"{BASE}/rest/v1/relationships_v2").mock(
        return_value=httpx.Response(200, json=[{"id": "rel-existing"}])
    )

    result = supabase_core.create_relationship("ent-1", "ent-2", "meeting_has_action_item", {})

    assert result == {"relationship_id": "rel-existing", "success": True}
    assert fallback.called
    url = str(fallback.calls.last.request.url)
    assert "parent_id=eq.ent-1" in url
    assert "child_id=eq.ent-2" in url
    assert "relationship_type=eq.meeting_has_action_item" in url
