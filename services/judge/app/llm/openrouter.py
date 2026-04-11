from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import httpx

from app.llm.client import (
    CrossExaminerResponse,
    EVIDENCE_STRENGTHS,
    LLMClient,
    LLMResponseError,
    LLMTransportError,
    PanelJudgeResponse,
    SearchResult,
)
from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_JUDGE_MODEL = "openai/gpt-5"
DEFAULT_CROSS_EXAMINER_MODEL = "openai/gpt-5"
DEFAULT_SEARCH_MODEL = "perplexity/sonar"
DEFAULT_TIMEOUT = 120.0
DEFAULT_MAX_TOKENS = 4000
DEFAULT_RETRIES = 2
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


PANEL_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "probability": {"type": "number", "minimum": 0, "maximum": 1},
        "evidenceStrength": {"type": "string", "enum": list(EVIDENCE_STRENGTHS)},
        "rationale": {"type": "string", "minLength": 1},
    },
    "required": ["probability", "evidenceStrength", "rationale"],
}

CROSS_EXAMINER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "conflicts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "judgeA": {"type": "string"},
                    "judgeB": {"type": "string"},
                    "reason": {"type": "string"},
                    "severity": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                    },
                },
                "required": ["judgeA", "judgeB", "reason", "severity"],
            },
        },
    },
    "required": ["conflicts"],
}


PANEL_JUDGE_PROMPTS: dict[str, str] = {
    "official_records": (
        "You are a forecaster who only reads official and government sources. "
        "Given an event and a set of official/government evidence items, return "
        "a probability (0 to 1) that the event resolves true, an evidenceStrength "
        "label, and a short rationale that cites specific evidence."
    ),
    "community_signal": (
        "You are a forecaster who reads community discussion and social signal. "
        "Given an event and community evidence, return a probability, evidenceStrength, "
        "and a short rationale. Be careful not to over-weight vocal minorities."
    ),
    "open_web_research": (
        "You are a forecaster who synthesizes web reporting and research notes. "
        "You have been given an event, a set of web evidence items, and a grounded "
        "web search summary. Return a probability, evidenceStrength, and a short "
        "rationale that integrates both the provided evidence and the search summary."
    ),
}


class OpenRouterLLMClient(LLMClient):
    """Real LLM client that talks to OpenRouter (OpenAI-compatible chat completions)."""

    def __init__(
        self,
        *,
        api_key: str,
        judge_model: str = DEFAULT_JUDGE_MODEL,
        cross_examiner_model: str = DEFAULT_CROSS_EXAMINER_MODEL,
        search_model: str = DEFAULT_SEARCH_MODEL,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        retries: int = DEFAULT_RETRIES,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("OpenRouterLLMClient requires a non-empty api_key")
        self._api_key = api_key
        self._judge_model = judge_model
        self._cross_examiner_model = cross_examiner_model
        self._search_model = search_model
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_tokens = max_tokens
        self._retries = retries
        self._http = http_client or httpx.Client(timeout=timeout)
        self._owns_client = http_client is None

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "OpenRouterLLMClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # -- Public protocol methods -------------------------------------------------

    def judge_panel(
        self,
        *,
        judge_name: str,
        event: EventInput,
        evidence: list[EvidenceItem],
        default_rationale: str,
    ) -> PanelJudgeResponse:
        system_prompt = PANEL_JUDGE_PROMPTS.get(
            judge_name,
            "You are a careful probabilistic forecaster. Return structured JSON.",
        )
        user_prompt = self._build_panel_user_prompt(
            judge_name=judge_name,
            event=event,
            evidence=evidence,
        )
        payload = self._chat(
            model=self._judge_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": f"{judge_name}_opinion",
                    "strict": True,
                    "schema": PANEL_RESPONSE_SCHEMA,
                },
            },
        )
        parsed = self._parse_json_content(payload)
        return self._coerce_panel_response(parsed, default_rationale=default_rationale)

    def cross_examine(
        self,
        *,
        raw_opinions: list[RawJudgeOpinion],
    ) -> CrossExaminerResponse:
        system_prompt = (
            "You are a skeptical reviewer of a panel of probabilistic forecasters. "
            "Given each judge's probability, evidence strength, and rationale, surface "
            "any conflicts between judges. A conflict exists when judges disagree "
            "materially (probability gap >= 0.2) or when one judge's reasoning "
            "contradicts another's. Return only the 'conflicts' array. Severity must "
            "be low, medium, or high."
        )
        serialized = [
            {
                "judgeName": opinion.judge_name,
                "probability": round(opinion.probability, 4),
                "evidenceStrength": opinion.evidence_strength,
                "rationale": opinion.rationale,
            }
            for opinion in raw_opinions
        ]
        user_prompt = (
            "Panel opinions:\n"
            + json.dumps(serialized, indent=2)
            + "\n\nReturn JSON: {\"conflicts\": [{\"judgeA\": ..., \"judgeB\": ..., \"reason\": ..., \"severity\": ...}]}"
        )
        payload = self._chat(
            model=self._cross_examiner_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "cross_examiner_result",
                    "strict": True,
                    "schema": CROSS_EXAMINER_SCHEMA,
                },
            },
        )
        parsed = self._parse_json_content(payload)
        conflicts = parsed.get("conflicts", [])
        if not isinstance(conflicts, list):
            raise LLMResponseError(f"cross_examiner returned non-list conflicts: {conflicts!r}")
        return CrossExaminerResponse(conflicts=conflicts)

    def search_web(self, *, query: str) -> SearchResult:
        system_prompt = (
            "You are a web research assistant. Answer the user's question in 2-4 "
            "paragraphs using recent public sources. Be specific about dates, "
            "quantities, and named entities when available."
        )
        payload = self._chat(
            model=self._search_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": query},
            ],
        )
        choice = payload["choices"][0]
        message = choice.get("message", {})
        content = message.get("content") or ""
        citations: list[dict[str, str]] = []
        for annotation in message.get("annotations", []) or []:
            if annotation.get("type") != "url_citation":
                continue
            citation_info = annotation.get("url_citation") or {}
            url = citation_info.get("url")
            if not url:
                continue
            citations.append(
                {
                    "title": str(citation_info.get("title") or url),
                    "url": str(url),
                    "snippet": str(citation_info.get("snippet") or ""),
                }
            )
        return SearchResult(content=str(content), citations=citations)

    # -- Helpers -----------------------------------------------------------------

    def _build_panel_user_prompt(
        self,
        *,
        judge_name: str,
        event: EventInput,
        evidence: list[EvidenceItem],
    ) -> str:
        evidence_items = [
            {
                "id": item.id,
                "sourceFamily": str(item.sourceFamily),
                "title": item.title,
                "publisher": item.publisher,
                "publishedAt": item.publishedAt,
                "summary": item.summary,
                "claims": list(item.claims or []),
                "stance": str(item.stance),
            }
            for item in evidence
        ]
        return (
            f"Event question: {event.question}\n"
            f"Resolution criteria: {event.resolutionCriteria}\n"
            f"Deadline: {event.deadline}\n"
            f"Reference class: {event.referenceClass}\n"
            f"Entities: {', '.join(str(entity) for entity in event.entities)}\n\n"
            f"Evidence items (judge = {judge_name}):\n"
            f"{json.dumps(evidence_items, indent=2)}\n\n"
            "Return JSON with keys: probability (0..1), evidenceStrength, rationale."
        )

    def _chat(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": self._max_tokens,
        }
        if response_format is not None:
            body["response_format"] = response_format

        url = f"{self._base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/ilya/Cassandra",
            "X-Title": "Cassandra Judge Service",
        }

        last_error: Exception | None = None
        for attempt in range(self._retries + 1):
            try:
                response = self._http.post(url, headers=headers, json=body)
            except httpx.TimeoutException as exc:
                last_error = exc
                logger.warning("openrouter timeout (attempt %d/%d): %s", attempt + 1, self._retries + 1, exc)
            except httpx.HTTPError as exc:
                last_error = exc
                logger.warning("openrouter http error (attempt %d/%d): %s", attempt + 1, self._retries + 1, exc)
            else:
                if response.status_code in RETRYABLE_STATUS:
                    last_error = LLMTransportError(
                        f"openrouter returned retryable status {response.status_code}: {response.text[:500]}"
                    )
                    logger.warning(
                        "openrouter retryable status %d (attempt %d/%d)",
                        response.status_code,
                        attempt + 1,
                        self._retries + 1,
                    )
                elif response.status_code >= 400:
                    raise LLMTransportError(
                        f"openrouter returned {response.status_code}: {response.text[:500]}"
                    )
                else:
                    try:
                        return response.json()
                    except json.JSONDecodeError as exc:
                        raise LLMResponseError(
                            f"openrouter returned non-JSON body: {response.text[:500]}"
                        ) from exc

            if attempt < self._retries:
                time.sleep(0.5 * (2 ** attempt))

        raise LLMTransportError(
            f"openrouter call failed after {self._retries + 1} attempts: {last_error}"
        )

    def _parse_json_content(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            choices = payload["choices"]
            if not choices:
                raise LLMResponseError("openrouter response has no choices")
            message = choices[0]["message"]
            content = message.get("content")
            finish_reason = choices[0].get("finish_reason")
        except (KeyError, TypeError) as exc:
            raise LLMResponseError(f"openrouter response malformed: {payload!r}") from exc

        if content is None or not isinstance(content, str) or not content.strip():
            raise LLMResponseError(
                f"openrouter returned empty content (finish_reason={finish_reason}); "
                "consider increasing max_tokens."
            )

        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise LLMResponseError(
                f"openrouter content was not valid JSON: {content[:500]}"
            ) from exc

        if not isinstance(parsed, dict):
            raise LLMResponseError(f"openrouter JSON was not an object: {parsed!r}")
        return parsed

    def _coerce_panel_response(
        self,
        parsed: dict[str, Any],
        *,
        default_rationale: str,
    ) -> PanelJudgeResponse:
        try:
            probability = float(parsed["probability"])
            strength = str(parsed["evidenceStrength"])
            rationale = str(parsed.get("rationale") or default_rationale)
        except (KeyError, ValueError, TypeError) as exc:
            raise LLMResponseError(f"panel response missing fields: {parsed!r}") from exc

        if not 0.0 <= probability <= 1.0:
            raise LLMResponseError(f"probability out of range: {probability}")
        if strength not in EVIDENCE_STRENGTHS:
            raise LLMResponseError(f"unknown evidenceStrength: {strength}")

        return PanelJudgeResponse(
            probability=probability,
            evidenceStrength=strength,
            rationale=rationale,
        )


def _env_value(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None
