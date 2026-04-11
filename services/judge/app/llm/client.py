from __future__ import annotations

from typing import Protocol, TypedDict

from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


class LLMError(Exception):
    """Base error for LLM client failures."""


class LLMTransportError(LLMError):
    """Network, timeout, or HTTP-level failure talking to the LLM gateway."""


class LLMResponseError(LLMError):
    """Model returned a response that could not be parsed or validated."""


EVIDENCE_STRENGTHS = (
    "strong_against",
    "moderate_against",
    "weak_against",
    "neutral",
    "weak_for",
    "moderate_for",
    "strong_for",
)


class PanelJudgeResponse(TypedDict):
    probability: float
    evidenceStrength: str
    rationale: str


class CrossExaminerConflict(TypedDict, total=False):
    judgeA: str
    judgeB: str
    reason: str
    severity: str


class CrossExaminerResponse(TypedDict):
    conflicts: list[CrossExaminerConflict]


class SearchCitation(TypedDict, total=False):
    title: str
    url: str
    snippet: str


class SearchResult(TypedDict):
    content: str
    citations: list[SearchCitation]


class LLMClient(Protocol):
    """Protocol implemented by every LLM backend used by the judge service."""

    def judge_panel(
        self,
        *,
        judge_name: str,
        event: EventInput,
        evidence: list[EvidenceItem],
        default_rationale: str,
    ) -> PanelJudgeResponse:
        ...

    def cross_examine(
        self,
        *,
        raw_opinions: list[RawJudgeOpinion],
    ) -> CrossExaminerResponse:
        ...

    def search_web(self, *, query: str) -> SearchResult:
        ...
