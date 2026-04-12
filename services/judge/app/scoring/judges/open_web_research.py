from __future__ import annotations

from app.llm.client import LLMClient
from app.llm.fake import FakeLLMClient
from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


def evaluate(
    event: EventInput,
    evidence: list[EvidenceItem],
    *,
    llm: LLMClient | None = None,
) -> RawJudgeOpinion:
    relevant = [
        item
        for item in evidence
        if item.sourceFamily in {"web", "llm_research"}
    ]
    client = llm or FakeLLMClient()
    panel_evidence = list(relevant)

    response = client.judge_panel(
        judge_name="open_web_research",
        event=event,
        evidence=panel_evidence,
        default_rationale=f"Open-web judge evaluated {event.question}",
    )

    warnings = [] if relevant else ["No open-web or search evidence was available."]
    missing = [] if relevant else ["Expected open web or research evidence."]

    return RawJudgeOpinion(
        judge_name="open_web_research",
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in panel_evidence],
        warnings=warnings,
        missing_evidence=missing,
    )
