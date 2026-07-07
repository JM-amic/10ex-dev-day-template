from __future__ import annotations
import httpx

from .config import settings


class LLMError(Exception):
    pass


def call_azure_responses(
    input_text: str,
    system: str | None = None,
    json_schema: dict | None = None,
    timeout: float = 60.0,
) -> str:
    """Call the Azure OpenAI Responses API and return the model's text output."""
    if not settings.azure_openai_endpoint or not settings.azure_openai_api_key:
        raise LLMError("Azure OpenAI is not configured (missing endpoint or api key)")

    body: dict = {"model": settings.azure_openai_model, "input": input_text}
    if system:
        body["instructions"] = system
    if json_schema:
        body["text"] = {
            "format": {
                "type": "json_schema",
                "name": "structured_output",
                "schema": json_schema,
                "strict": True,
            }
        }

    url = f"{settings.azure_openai_endpoint}?api-version={settings.azure_openai_api_version}"
    response = httpx.post(
        url,
        headers={"api-key": settings.azure_openai_api_key, "Content-Type": "application/json"},
        json=body,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()

    for item in data.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    return content["text"]

    raise LLMError(f"No text output in Azure OpenAI response: {data}")
