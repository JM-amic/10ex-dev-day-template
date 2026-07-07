from __future__ import annotations
import logging
from dataclasses import dataclass
from typing import Any, Dict

import httpx
from temporalio import activity

from ..llm_client import call_azure_responses, LLMError

logger = logging.getLogger(__name__)


@dataclass
class LLMCallResult:
    text: str
    success: bool = True
    error: str | None = None


@activity.defn
def call_model(
    input_text: str,
    system: str | None = None,
    json_schema: Dict[str, Any] | None = None,
) -> LLMCallResult:
    logger.info("Calling model", extra={"input_len": len(input_text)})
    try:
        text = call_azure_responses(input_text, system=system, json_schema=json_schema)
        return LLMCallResult(text=text)
    except (LLMError, httpx.HTTPError) as exc:
        logger.error("Model call failed", extra={"error": str(exc)})
        return LLMCallResult(text="", success=False, error=str(exc))
