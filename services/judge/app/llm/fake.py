from __future__ import annotations

from typing import Any

from app.llm.client import (
    BaseRateEstimate,
    CrossExaminerResponse,
    EvidenceRating,
    LLMClient,
    PanelJudgeResponse,
    QueryPlan,
    SearchResult,
)
from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


CROSS_EXAMINER_KEY = "__cross_examiner__"
SEARCH_KEY = "__search__"
RELEVANCE_KEY = "__relevance__"
PLAN_KEY = "__plan__"
BASE_RATE_KEY = "__base_rate__"
DEFAULT_FAKE_RELEVANCE = 5


class FakeLLMClient(LLMClient):
    """Deterministic in-process LLM stand-in used by unit tests and fixture mode."""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self._responses = responses or {}

    def judge_panel(
        self,
        *,
        judge_name: str,
        event: EventInput,
        evidence: list[EvidenceItem],
        default_rationale: str,
        evaluation_time: str | None = None,
    ) -> PanelJudgeResponse:
        if judge_name in self._responses:
            canned = dict(self._responses[judge_name])
            return PanelJudgeResponse(
                probability=float(canned["probability"]),
                evidenceStrength=str(canned["evidenceStrength"]),
                rationale=str(canned["rationale"]),
            )

        support = sum(1 for item in evidence if item.stance == "supports")
        contradict = sum(1 for item in evidence if item.stance == "contradicts")
        score = support - contradict

        if score >= 2:
            strength = "moderate_for"
            probability = 0.7
        elif score == 1:
            strength = "weak_for"
            probability = 0.6
        elif score <= -2:
            strength = "moderate_against"
            probability = 0.3
        elif score == -1:
            strength = "weak_against"
            probability = 0.4
        else:
            strength = "neutral"
            probability = 0.5

        return PanelJudgeResponse(
            probability=probability,
            evidenceStrength=strength,
            rationale=default_rationale,
        )

    def cross_examine(
        self,
        *,
        raw_opinions: list[RawJudgeOpinion],
    ) -> CrossExaminerResponse:
        if CROSS_EXAMINER_KEY in self._responses:
            canned = self._responses[CROSS_EXAMINER_KEY]
            return CrossExaminerResponse(conflicts=list(canned.get("conflicts", [])))

        conflicts: list[dict[str, str]] = []
        for index, left in enumerate(raw_opinions):
            for right in raw_opinions[index + 1 :]:
                probability_gap = abs(left.probability - right.probability)
                if probability_gap < 0.25:
                    continue
                conflicts.append(
                    {
                        "judgeA": left.judge_name,
                        "judgeB": right.judge_name,
                        "reason": f"Probability gap of {probability_gap:.2f} between judge opinions.",
                        "severity": "high" if probability_gap >= 0.5 else "medium",
                    }
                )
        return CrossExaminerResponse(conflicts=conflicts)

    def search_web(self, *, query: str) -> SearchResult:
        if SEARCH_KEY in self._responses:
            canned = self._responses[SEARCH_KEY]
            return SearchResult(
                content=str(canned.get("content", "")),
                citations=list(canned.get("citations", [])),
            )
        # Default: return empty so judges that call search_web do not synthesize
        # evidence in unit tests. Tests that want a search signal can seed the
        # ``__search__`` key.
        return SearchResult(content="", citations=[])

    def rate_evidence(
        self,
        *,
        event: EventInput,
        evidence: list[EvidenceItem],
        evaluation_time: str | None = None,
    ) -> list[EvidenceRating]:
        # Default: everything is relevant and keeps its own summary, so tests that do not
        # seed ratings see the evidence they supplied.
        canned = self._responses.get(RELEVANCE_KEY, {})
        ratings: list[EvidenceRating] = []
        for item in evidence:
            entry = canned.get(item.id, {})
            ratings.append(
                EvidenceRating(
                    id=item.id,
                    relevance=int(entry.get("relevance", DEFAULT_FAKE_RELEVANCE)),
                    summary=str(entry.get("summary", item.summary)),
                )
            )
        return ratings

    def plan_queries(
        self,
        *,
        event: EventInput,
        evaluation_time: str | None = None,
        max_queries: int = 4,
    ) -> QueryPlan:
        if PLAN_KEY in self._responses:
            canned = self._responses[PLAN_KEY]
            return QueryPlan(
                subQuestions=list(canned.get("subQuestions", [])),
                queries=list(canned.get("queries", [])),
            )
        return QueryPlan(subQuestions=[event.question], queries=[])

    def estimate_base_rate(
        self,
        *,
        event: EventInput,
        evaluation_time: str | None = None,
    ) -> BaseRateEstimate | None:
        # No estimate unless a test seeds one, so fixture-mode priors stay deterministic.
        canned = self._responses.get(BASE_RATE_KEY)
        if canned is None:
            return None
        estimate = BaseRateEstimate(
            probability=float(canned["probability"]),
            rationale=str(canned.get("rationale", "")),
        )
        if canned.get("referenceClass"):
            estimate["referenceClass"] = str(canned["referenceClass"])
        return estimate
