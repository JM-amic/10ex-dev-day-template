from __future__ import annotations
import asyncio
import json
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Dict, List, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from ...activities import llm, supabase_core

ACTIVITY_TIMEOUT = timedelta(seconds=30)
MODEL_TIMEOUT = timedelta(seconds=90)
SUPABASE_RETRY = RetryPolicy(maximum_attempts=5)
MODEL_RETRY = RetryPolicy(maximum_attempts=3)

TURN_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "argument": {"type": "string"},
    },
    "required": ["headline", "argument"],
    "additionalProperties": False,
}

VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "recommendation": {"type": "string"},
    },
    "required": ["summary", "recommendation"],
    "additionalProperties": False,
}


@dataclass
class RunDebateRequest:
    entity_id: str


def _format_transcript(transcript: List[Dict[str, Any]]) -> str:
    if not transcript:
        return "(No arguments yet -- this is the first round.)"
    return "\n".join(f"Round {t['round']} -- {t['label']}: {t['argument']}" for t in transcript)


def _persona_system_prompt(persona: Dict[str, Any], topic: str, language: str) -> str:
    return (
        f"You are {persona['label']}, a debate persona. Personality: "
        f"{persona.get('personality', '')} {persona['stance_prompt']} "
        f'You are participating in a multi-persona debate about: "{topic}". '
        "Write your argument for this round in your own voice, directly addressing the topic "
        "and, where relevant, engaging with what other personas have argued so far. "
        "Keep it focused and concrete -- a paragraph, not an essay. "
        "Also provide a `headline`: a single punchy sentence (max ~12 words) that captures "
        "the essence of your argument, so a reader can skim the debate at a glance. "
        f"Write both the headline and the argument entirely in {language}, regardless of the "
        "language of the topic or of the other personas' arguments."
    )


def _round_input(topic: str, transcript_text: str, round_number: int, round_count: int) -> str:
    return (
        f"Topic: {topic}\n"
        f"This is round {round_number} of {round_count}.\n"
        f"Transcript so far:\n{transcript_text}\n\n"
        "Give your argument for this round now."
    )


def _judge_system_prompt(judge: Dict[str, Any], topic: str, language: str) -> str:
    return (
        f'You are {judge["label"]}, the impartial judge of a multi-persona debate about: "{topic}". '
        f"{judge.get('personality', '')} {judge['stance_prompt']} "
        "Read the full transcript below and weigh every argument on its merits. Then produce a "
        "fair, concise verdict: a summary of the strongest points made on each side, and a "
        "concrete, actionable recommendation for the person who posed this topic. "
        f"Write your entire verdict (both summary and recommendation) in {language}."
    )


@workflow.defn
class RunDebateWorkflow:
    @workflow.run
    async def run(self, request: RunDebateRequest) -> dict:
        version_number: Optional[int] = None
        data: Optional[Dict[str, Any]] = None
        current_round_in_flight = 0

        async def _mark(status: str, **extra) -> int:
            nonlocal version_number
            version_number += 1
            await workflow.execute_activity(
                supabase_core.update_entity_scd2,
                args=[request.entity_id, version_number, {**data, "processing_status": status, **extra}, None],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )
            return version_number

        try:
            entity = await workflow.execute_activity(
                supabase_core.get_entity,
                args=[request.entity_id],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )
            version_number = entity["version_number"]
            data = entity["data"]

            personas: List[Dict[str, Any]] = data["selected_personas"]
            judge: Dict[str, Any] = data["judge_persona"]
            round_count: int = data["round_count"]
            topic: str = data["topic"]
            # Older debates predate the language selector; default to English.
            language: str = data.get("language") or "English"

            # No separate pre-loop "processing" mark: round 1's iteration below performs the
            # pending -> processing transition itself, via the same _mark call every round uses.
            transcript: List[Dict[str, Any]] = []
            for round_number_in_debate in range(1, round_count + 1):
                current_round_in_flight = round_number_in_debate
                # Mark BEFORE this round's activities run, so current_round always names the
                # round currently in flight, never a completed-then-stale round number.
                await _mark("processing", current_round=round_number_in_debate)
                transcript_text = _format_transcript(transcript)

                async def run_turn(persona: Dict[str, Any]) -> Dict[str, Any]:
                    system = _persona_system_prompt(persona, topic, language)
                    input_text = _round_input(topic, transcript_text, round_number_in_debate, round_count)
                    argument: Optional[str] = None
                    headline = ""
                    error: Optional[str] = None
                    try:
                        result = await workflow.execute_activity(
                            llm.call_model,
                            args=[input_text, system, TURN_SCHEMA],
                            start_to_close_timeout=MODEL_TIMEOUT,
                            retry_policy=MODEL_RETRY,
                        )
                        if not result.success:
                            error = result.error
                        else:
                            parsed = json.loads(result.text)
                            argument = parsed["argument"]
                            headline = parsed.get("headline", "")
                    except Exception as exc:  # noqa: BLE001 -- per-persona isolation, see ADR-0002
                        error = str(exc.__cause__ or exc)

                    text = (
                        argument
                        if argument is not None
                        else f"[{persona['label']} had nothing to say -- model call failed: {error}]"
                    )
                    turn_entity = await workflow.execute_activity(
                        supabase_core.create_entity,
                        args=[
                            "debate_turn",
                            {
                                "round_number": round_number_in_debate,
                                "persona_key": persona["key"],
                                "persona_label": persona["label"],
                                "persona_emoji": persona["emoji"],
                                "headline": headline,
                                "argument": text,
                                "is_placeholder": argument is None,
                            },
                            None,
                            f"{request.entity_id}:turn:{round_number_in_debate}:{persona['key']}",
                        ],
                        start_to_close_timeout=ACTIVITY_TIMEOUT,
                        retry_policy=SUPABASE_RETRY,
                    )
                    await workflow.execute_activity(
                        supabase_core.create_relationship,
                        args=[request.entity_id, turn_entity.entity_id, "debate_has_turn", {}],
                        start_to_close_timeout=ACTIVITY_TIMEOUT,
                        retry_policy=SUPABASE_RETRY,
                    )
                    return {"round": round_number_in_debate, "label": persona["label"], "argument": text}

                results = await asyncio.gather(*(run_turn(p) for p in personas))
                transcript.extend(results)

            verdict_result = await workflow.execute_activity(
                llm.call_model,
                args=[_format_transcript(transcript), _judge_system_prompt(judge, topic, language), VERDICT_SCHEMA],
                start_to_close_timeout=MODEL_TIMEOUT,
                retry_policy=MODEL_RETRY,
            )
            if not verdict_result.success:
                raise RuntimeError(f"Judge model call failed: {verdict_result.error}")
            verdict = json.loads(verdict_result.text)

            verdict_entity = await workflow.execute_activity(
                supabase_core.create_entity,
                args=[
                    "debate_verdict",
                    {
                        "persona_key": judge["key"],
                        "persona_label": judge["label"],
                        "persona_emoji": judge["emoji"],
                        **verdict,
                    },
                    None,
                    f"{request.entity_id}:verdict",
                ],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )
            await workflow.execute_activity(
                supabase_core.create_relationship,
                args=[request.entity_id, verdict_entity.entity_id, "debate_has_verdict", {}],
                start_to_close_timeout=ACTIVITY_TIMEOUT,
                retry_policy=SUPABASE_RETRY,
            )

            await _mark("done", current_round=round_count)
            return {"status": "done", "round_count": round_count}

        except Exception as exc:  # noqa: BLE001 -- deliberately broad: terminal safety net
            # Activity failures surface as ActivityError, whose own str() is a generic
            # "Activity task failed" -- the real message is chained onto __cause__.
            message = str(exc.__cause__) if exc.__cause__ else str(exc)
            try:
                if data is None:
                    raise RuntimeError("entity data was never fetched")
                await _mark("error", error_message=message, current_round=current_round_in_flight)
            except Exception:
                # Either get_entity itself failed (data is None, so _mark can't spread it) or
                # the primary error write failed too -- fall back to a minimal error record
                # that doesn't depend on `data` at all, so an error status always gets written.
                # Entities are always created at version_number=1 right before this workflow is
                # triggered (see submitDebate), matching the same fallback in
                # extract_action_items_workflow.py.
                fallback_version = (version_number or 1) + 1
                await workflow.execute_activity(
                    supabase_core.update_entity_scd2,
                    args=[
                        request.entity_id,
                        fallback_version,
                        {
                            "processing_status": "error",
                            "error_message": message,
                            "current_round": current_round_in_flight,
                        },
                        None,
                    ],
                    start_to_close_timeout=ACTIVITY_TIMEOUT,
                    retry_policy=SUPABASE_RETRY,
                )
            return {"status": "error", "error": message}
