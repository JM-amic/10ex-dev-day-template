from __future__ import annotations
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError

from .config import settings
from .workflows.meeting_notes.extract_action_items_workflow import (
    ExtractActionItemsRequest,
    ExtractActionItemsWorkflow,
)

logger = logging.getLogger(__name__)

CORS_ORIGIN = os.environ.get("TRIGGER_CORS_ORIGIN", "http://localhost:3000")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.temporal_client = await Client.connect(
        settings.temporal_address, namespace=settings.temporal_namespace
    )
    logger.info("Connected to Temporal", extra={"address": settings.temporal_address})
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExtractActionItemsBody(BaseModel):
    entity_id: str = Field(..., min_length=1)


@app.post("/workflows/extract-action-items", status_code=202)
async def extract_action_items(body: ExtractActionItemsBody, request: Request) -> JSONResponse:
    client: Client = request.app.state.temporal_client
    workflow_id = f"extract-actions-{body.entity_id}"

    try:
        await client.start_workflow(
            ExtractActionItemsWorkflow.run,
            ExtractActionItemsRequest(entity_id=body.entity_id),
            id=workflow_id,
            task_queue=settings.temporal_task_queue,
        )
    except WorkflowAlreadyStartedError:
        return JSONResponse(status_code=202, content={"started": False, "already_running": True})
    except RPCError as exc:
        logger.error("Failed to reach Temporal", extra={"error": str(exc)})
        return JSONResponse(status_code=502, content={"error": "Could not reach Temporal"})

    return JSONResponse(status_code=202, content={"workflow_id": workflow_id, "started": True})
