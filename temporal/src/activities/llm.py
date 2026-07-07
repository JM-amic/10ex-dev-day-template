from __future__ import annotations
import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional
from temporalio import activity

from ..llm_client import call_azure_responses, LLMError

logger = logging.getLogger(__name__)


@dataclass
class LLMCallResult:
    text: str
    success: bool = True
    error: Optional[str] = None


@activity.defn
def call_model(
    input_text: str,
    system: Optional[str] = None,
    json_schema: Optional[Dict[str, Any]] = None,
) -> LLMCallResult:
    logger.info("Calling model", extra={"input_len": len(input_text)})
    try:
        text = call_azure_responses(input_text, system=system, json_schema=json_schema)
        return LLMCallResult(text=text)
    except LLMError as exc:
        logger.error("Model call failed", extra={"error": str(exc)})
        return LLMCallResult(text="", success=False, error=str(exc))
