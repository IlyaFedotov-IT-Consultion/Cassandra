"""Multi-model, multi-sample judge ensembles.

Single LLM forecasts are noisy; aggregating several samples or model families is the
best-supported fix in the literature (Halawi et al. 2024, arXiv:2402.18563; Schoenegger
et al. 2024, arXiv:2402.19379; Turtel et al. 2025, arXiv:2505.17989). Members run
concurrently; the median is taken in log-odds for the probability and over log Bayes
factors for the evidence strength, which is robust to one outlying member.
"""
from __future__ import annotations

from math import exp, log
from statistics import median

from app.llm.client import (
    CrossExaminerResponse,
    EvidenceRating,
    LLMClient,
    LLMError,
    LLMResponseError,
    PanelJudgeResponse,
    QueryPlan,
    SearchResult,
)
from app.models_generated import EventInput, EvidenceItem
from app.observability import ContextThreadPoolExecutor
from app.scoring.strength_map import DEFAULT_STRENGTH_TO_LOG_BF
from app.scoring.types import RawJudgeOpinion


def parse_model_specs(value: str) -> list[tuple[str, str | None]]:
    """Parse "model@effort, model" into (model, reasoning effort or None) pairs."""
    specs: list[tuple[str, str | None]] = []
    for raw in value.split(","):
        entry = raw.strip()
        if not entry:
            continue
        model, _, effort = entry.partition("@")
        specs.append((model.strip(), effort.strip() or None))
    return specs


def _logit(probability: float) -> float:
    bounded = min(max(probability, 1e-6), 1 - 1e-6)
    return log(bounded / (1 - bounded))


INCOHERENT_MIN_ABS_LOG_BF = 1.5
INCOHERENT_MIN_PROBABILITY_MARGIN = 0.25


def is_incoherent_sample(sample: dict) -> bool:
    """A moderate/strong label pointing one way while the sample's own probability is
    firmly on the other side of 0.5 (e.g. strong_against with p=0.92) is self-contradictory:
    judges do not see the prior, so their probability reflects the evidence they read."""
    log_bf = DEFAULT_STRENGTH_TO_LOG_BF[sample["evidenceStrength"]]
    probability = sample["probability"]
    return (
        abs(log_bf) >= INCOHERENT_MIN_ABS_LOG_BF
        and abs(probability - 0.5) >= INCOHERENT_MIN_PROBABILITY_MARGIN
        and (log_bf > 0) != (probability > 0.5)
    )


def _nearest_strength(log_bayes_factor: float) -> str:
    # Ties resolve toward the weaker label so the label never overstates the evidence.
    return min(
        DEFAULT_STRENGTH_TO_LOG_BF,
        key=lambda label: (abs(DEFAULT_STRENGTH_TO_LOG_BF[label] - log_bayes_factor), abs(DEFAULT_STRENGTH_TO_LOG_BF[label])),
    )


class EnsembleLLMClient(LLMClient):
    def __init__(
        self,
        members: list[tuple[str, LLMClient]],
        *,
        cross_examiner: LLMClient | None = None,
        utility: LLMClient | None = None,
        max_workers: int = 8,
    ) -> None:
        if not members:
            raise ValueError("EnsembleLLMClient requires at least one member")
        self._members = members
        self._cross_examiner = cross_examiner or members[0][1]
        # Cheap stages (relevance rating, query planning) run once, on the utility client.
        self._utility = utility or self._cross_examiner
        self._max_workers = max_workers

    @property
    def model_version(self) -> str:
        return "ensemble[" + ",".join(name for name, _ in self._members) + "]"

    def judge_panel(
        self,
        *,
        judge_name: str,
        event: EventInput,
        evidence: list[EvidenceItem],
        default_rationale: str,
        evaluation_time: str | None = None,
    ) -> PanelJudgeResponse:
        def ask(member: tuple[str, LLMClient]):
            name, client = member
            try:
                return name, client.judge_panel(
                    judge_name=judge_name,
                    event=event,
                    evidence=evidence,
                    default_rationale=default_rationale,
                    evaluation_time=evaluation_time,
                ), None
            except LLMError as error:
                return name, None, error

        with ContextThreadPoolExecutor(max_workers=min(self._max_workers, len(self._members))) as pool:
            results = list(pool.map(ask, self._members))

        samples = [
            {
                "model": name,
                "probability": float(response["probability"]),
                "evidenceStrength": str(response["evidenceStrength"]),
                "rationale": str(response["rationale"]),
            }
            for name, response, _ in results
            if response is not None
        ]
        failures = [f"{name} failed: {error}" for name, _, error in results if error is not None]
        if not samples:
            raise LLMResponseError(f"every ensemble member failed for {judge_name}: {'; '.join(failures)}")

        used = [sample for sample in samples if not is_incoherent_sample(sample)]
        if used:
            for sample in samples:
                if is_incoherent_sample(sample):
                    sample["excluded"] = "label contradicts probability"
                    failures.append(
                        f"{sample['model']} excluded: {sample['evidenceStrength']} contradicts p={sample['probability']:.2f}"
                    )
        else:
            used = samples
            failures.append("all ensemble samples were incoherent (label vs probability); using all of them")

        probability = 1 / (1 + exp(-median(_logit(sample["probability"]) for sample in used)))
        log_bayes_factor = median(DEFAULT_STRENGTH_TO_LOG_BF[sample["evidenceStrength"]] for sample in used)
        representative = min(
            used,
            key=lambda sample: abs(DEFAULT_STRENGTH_TO_LOG_BF[sample["evidenceStrength"]] - log_bayes_factor),
        )
        return PanelJudgeResponse(
            probability=probability,
            evidenceStrength=_nearest_strength(log_bayes_factor),
            rationale=f"[{representative['model']}] {representative['rationale']}",
            logBayesFactor=log_bayes_factor,
            samples=samples,
            warnings=failures,
        )

    def cross_examine(self, *, raw_opinions: list[RawJudgeOpinion]) -> CrossExaminerResponse:
        return self._cross_examiner.cross_examine(raw_opinions=raw_opinions)

    def search_web(self, *, query: str) -> SearchResult:
        return self._members[0][1].search_web(query=query)

    @property
    def utility_model_version(self) -> str:
        return str(getattr(self._utility, "utility_model_version", "unknown"))

    def rate_evidence(
        self,
        *,
        event: EventInput,
        evidence: list[EvidenceItem],
        evaluation_time: str | None = None,
    ) -> list[EvidenceRating]:
        return self._utility.rate_evidence(event=event, evidence=evidence, evaluation_time=evaluation_time)

    def plan_queries(
        self,
        *,
        event: EventInput,
        evaluation_time: str | None = None,
        max_queries: int = 4,
    ) -> QueryPlan:
        return self._utility.plan_queries(event=event, evaluation_time=evaluation_time, max_queries=max_queries)

    def close(self) -> None:
        for _, client in self._members:
            close = getattr(client, "close", None)
            if callable(close):
                close()
        if all(self._cross_examiner is not client for _, client in self._members):
            close = getattr(self._cross_examiner, "close", None)
            if callable(close):
                close()
