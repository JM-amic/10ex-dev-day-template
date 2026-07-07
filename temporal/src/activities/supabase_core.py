from __future__ import annotations
import logging
from dataclasses import dataclass
from typing import Any, Dict

import httpx
from temporalio import activity

from ..config import settings

logger = logging.getLogger(__name__)

_TIMEOUT = 10.0


def _headers() -> dict:
    return {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Content-Type": "application/json",
    }


@dataclass
class EntityResult:
    entity_id: str
    version_id: str
    success: bool = True
    error: str | None = None


def _pg_error_code(response: httpx.Response) -> str | None:
    try:
        return response.json().get("code")
    except (ValueError, AttributeError):
        return None


@activity.defn
def create_entity(
    entity_type: str,
    attributes: Dict[str, Any],
    created_by: str | None = None,
    source_record_id: str | None = None,
) -> EntityResult:
    if source_record_id:
        entity_resp = httpx.post(
            f"{settings.supabase_url}/rest/v1/entities?on_conflict=entity_type,source_record_id",
            headers={**_headers(), "Prefer": "return=representation,resolution=merge-duplicates"},
            json={"entity_type": entity_type, "source_record_id": source_record_id},
            timeout=_TIMEOUT,
        )
    else:
        entity_resp = httpx.post(
            f"{settings.supabase_url}/rest/v1/entities",
            headers={**_headers(), "Prefer": "return=representation"},
            json={"entity_type": entity_type},
            timeout=_TIMEOUT,
        )
    entity_resp.raise_for_status()
    entity_id = entity_resp.json()[0]["id"]

    version_resp = httpx.post(
        f"{settings.supabase_url}/rest/v1/entity_versions",
        headers={**_headers(), "Prefer": "return=representation"},
        json={"entity_id": entity_id, "version_number": 1, "data": attributes, "is_current": True},
        timeout=_TIMEOUT,
    )
    if version_resp.status_code == 409 or _pg_error_code(version_resp) == "23505":
        # A prior attempt already created version 1 for this entity (idempotent retry).
        existing = httpx.get(
            f"{settings.supabase_url}/rest/v1/entity_versions",
            headers=_headers(),
            params={"entity_id": f"eq.{entity_id}", "version_number": "eq.1", "select": "id"},
            timeout=_TIMEOUT,
        )
        existing.raise_for_status()
        return EntityResult(entity_id=entity_id, version_id=existing.json()[0]["id"])

    version_resp.raise_for_status()
    version_id = version_resp.json()[0]["id"]

    return EntityResult(entity_id=entity_id, version_id=version_id)


@activity.defn
def update_entity_scd2(
    entity_id: str,
    version_number: int,
    attributes: Dict[str, Any],
    updated_by: str | None = None,
) -> EntityResult:
    response = httpx.post(
        f"{settings.supabase_url}/rest/v1/entity_versions",
        headers={**_headers(), "Prefer": "return=representation"},
        json={"entity_id": entity_id, "version_number": version_number, "data": attributes, "is_current": True},
        timeout=_TIMEOUT,
    )

    if response.status_code == 409 or _pg_error_code(response) == "23505":
        logger.info(
            "update_entity_scd2 version already applied (idempotent retry)",
            extra={"entity_id": entity_id, "version_number": version_number},
        )
        return EntityResult(entity_id=entity_id, version_id="", success=True)

    response.raise_for_status()
    version_id = response.json()[0]["id"]
    return EntityResult(entity_id=entity_id, version_id=version_id)


@activity.defn
def get_entity(entity_id: str) -> Dict[str, Any]:
    response = httpx.get(
        f"{settings.supabase_url}/rest/v1/entities",
        headers=_headers(),
        params={
            "id": f"eq.{entity_id}",
            "select": "id,entity_type,entity_versions(id,version_number,data)",
            "entity_versions.is_current": "eq.true",
        },
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    row = response.json()[0]
    version = row["entity_versions"][0]
    return {
        "entity_id": row["id"],
        "version_id": version["id"],
        "version_number": version["version_number"],
        "data": version["data"],
    }


@activity.defn
def append_event(entity_id: str, entity_type: str, event_type: str, event_data: Dict[str, Any], actor_id: str | None = None, correlation_id: str | None = None) -> bool:
    logger.info(
        "[STUB] append_event",
        extra={"entity_id": entity_id, "event_type": event_type, "actor_id": actor_id, "correlation_id": correlation_id},
    )
    return True


@activity.defn
def create_relationship(from_entity_id: str, to_entity_id: str, relationship_type: str, attributes: Dict[str, Any] | None = None) -> Dict[str, Any]:
    response = httpx.post(
        f"{settings.supabase_url}/rest/v1/relationships_v2",
        headers={**_headers(), "Prefer": "return=representation"},
        json={
            "parent_id": from_entity_id,
            "child_id": to_entity_id,
            "relationship_type": relationship_type,
            "metadata": attributes or {},
        },
        timeout=_TIMEOUT,
    )
    if response.status_code == 409 or _pg_error_code(response) == "23505":
        # The unique index on (relationship_type, parent_id, child_id) where is_current
        # already has this relationship from a prior attempt (idempotent retry).
        existing = httpx.get(
            f"{settings.supabase_url}/rest/v1/relationships_v2",
            headers=_headers(),
            params={
                "parent_id": f"eq.{from_entity_id}",
                "child_id": f"eq.{to_entity_id}",
                "relationship_type": f"eq.{relationship_type}",
                "is_current": "eq.true",
                "select": "id",
            },
            timeout=_TIMEOUT,
        )
        existing.raise_for_status()
        return {"relationship_id": existing.json()[0]["id"], "success": True}

    response.raise_for_status()
    relationship_id = response.json()[0]["id"]
    return {"relationship_id": relationship_id, "success": True}
