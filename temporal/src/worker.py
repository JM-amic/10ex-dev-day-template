from __future__ import annotations
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from temporalio.client import Client
from temporalio.worker import Worker

from .config import settings
from .activities import supabase_core, notifications, llm
from .workflows.example.approval_workflow import ApprovalWorkflow
from .workflows.meeting_notes.extract_action_items_workflow import ExtractActionItemsWorkflow
from .workflows.debate_arena.debate_workflow import RunDebateWorkflow

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main() -> None:
    logger.info("Connecting to Temporal", extra={"address": settings.temporal_address, "namespace": settings.temporal_namespace})
    client = await Client.connect(settings.temporal_address, namespace=settings.temporal_namespace)

    activity_executor = ThreadPoolExecutor(max_workers=20)
    worker = Worker(
        client,
        task_queue=settings.temporal_task_queue,
        workflows=[ApprovalWorkflow, ExtractActionItemsWorkflow, RunDebateWorkflow],
        activities=[
            supabase_core.create_entity,
            supabase_core.update_entity_scd2,
            supabase_core.get_entity,
            supabase_core.append_event,
            supabase_core.create_relationship,
            notifications.send_email,
            notifications.send_notification,
            llm.call_model,
        ],
        activity_executor=activity_executor,
    )

    logger.info("Worker started", extra={"task_queue": settings.temporal_task_queue})
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
