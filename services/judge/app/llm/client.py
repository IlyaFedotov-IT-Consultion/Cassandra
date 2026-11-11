from __future__ import annotations

from typing import Any, NotRequired, Protocol, TypedDict

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
    # Set by ensembles: the aggregated (possibly fractional) log Bayes factor, the
    # individual member samples, and members that failed.
    logBayesFactor: NotRequired[float]
    samples: NotRequired[list[dict[str, Any]]]
    warnings: NotRequired[list[str]]


class EvidenceRating(TypedDict):
    id: str
    relevance: int  # 1 (unrelated) .. 6 (directly decisive)
    summary: str


class QueryPlan(TypedDict):
    subQuestions: list[str]
    queries: list[str]


class BaseRateEstimate(TypedDict):
    """An outside-view probability for a question, made without any evidence."""

    probability: float
    rationale: str
    referenceClass: NotRequired[str]
    # Set by ensembles: each member's estimate.
    samples: NotRequired[list[dict[str, Any]]]


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
        evaluation_time: str | None = None,
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

    def rate_evidence(
        self,
        *,
        event: EventInput,
        evidence: list[EvidenceItem],
        evaluation_time: str | None = None,
    ) -> list[EvidenceRating]:
        ...

    def plan_queries(
        self,
        *,
        event: EventInput,
        evaluation_time: str | None = None,
        max_queries: int = 4,
    ) -> QueryPlan:
        ...

    def estimate_base_rate(
        self,
        *,
        event: EventInput,
        evaluation_time: str | None = None,
    ) -> BaseRateEstimate | None:
        """Outside-view base rate for the question, or None when the backend has none."""
        ...
