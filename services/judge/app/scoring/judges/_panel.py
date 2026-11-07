from __future__ import annotations

from app.llm.client import LLMClient
from app.llm.fake import FakeLLMClient
from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


def run_panel_judge(
    *,
    judge_name: str,
    event: EventInput,
    relevant: list[EvidenceItem],
    llm: LLMClient | None,
    evaluation_time: str | None,
    no_evidence_warning: str,
    missing_evidence: str,
) -> RawJudgeOpinion:
    """Run one evidence-reading judge; without relevant evidence it is neutral and skips the LLM."""
    if not relevant:
        return RawJudgeOpinion(
            judge_name=judge_name,
            probability=0.5,
            evidence_strength="neutral",
            rationale=f"No relevant evidence was available, so {judge_name} is neutral by construction.",
            evidence_ids=[],
            warnings=[no_evidence_warning],
            missing_evidence=[missing_evidence],
        )

    client = llm or FakeLLMClient()
    response = client.judge_panel(
        judge_name=judge_name,
        event=event,
        evidence=relevant,
        default_rationale=f"{judge_name} evaluated {event.question}",
        evaluation_time=evaluation_time,
    )
    log_bayes_factor = response.get("logBayesFactor")
    return RawJudgeOpinion(
        judge_name=judge_name,
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in relevant],
        warnings=list(response.get("warnings", [])),
        missing_evidence=[],
        log_bayes_factor=float(log_bayes_factor) if log_bayes_factor is not None else None,
        samples=list(response.get("samples", [])),
    )
