from __future__ import annotations

from app.models_generated import EventInput, EvidenceItem
from app.scoring.judges._fake_llm import FakeLLM
from app.scoring.types import RawJudgeOpinion


def evaluate(event: EventInput, evidence: list[EvidenceItem], *, llm: FakeLLM | None = None) -> RawJudgeOpinion:
    relevant = [item for item in evidence if item.sourceFamily in {"web", "llm_research"}]
    generator = llm or FakeLLM({})
    response = generator.generate(
        "open_web_research",
        evidence=relevant,
        default_rationale=f"Open-web judge evaluated {event.question}",
    )
    return RawJudgeOpinion(
        judge_name="open_web_research",
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in relevant],
        warnings=[] if relevant else ["No open-web evidence found."],
        missing_evidence=[] if relevant else ["Expected open web or research evidence."],
    )
