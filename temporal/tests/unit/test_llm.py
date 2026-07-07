from __future__ import annotations

import httpx

from src.activities import llm
from src.llm_client import LLMError


def test_call_model_success(monkeypatch):
    def fake_call(input_text, system=None, json_schema=None):
        return '{"items": []}'

    monkeypatch.setattr(llm, "call_azure_responses", fake_call)

    result = llm.call_model("some notes")

    assert result.success is True
    assert result.text == '{"items": []}'
    assert result.error is None


def test_call_model_llm_error(monkeypatch):
    def fake_call(input_text, system=None, json_schema=None):
        raise LLMError("Azure OpenAI is not configured")

    monkeypatch.setattr(llm, "call_azure_responses", fake_call)

    result = llm.call_model("some notes")

    assert result.success is False
    assert result.text == ""
    assert result.error == "Azure OpenAI is not configured"


def test_call_model_http_error(monkeypatch):
    def fake_call(input_text, system=None, json_schema=None):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(llm, "call_azure_responses", fake_call)

    result = llm.call_model("some notes")

    assert result.success is False
    assert result.text == ""
    assert "connection refused" in result.error
