from __future__ import annotations

from app.models_generated import EventInput, EvidenceItem
from app.scoring.judges._fake_llm import FakeLLM
from app.scoring.types import RawJudgeOpinion


def evaluate(event: EventInput, evidence: list[EvidenceItem], *, llm: FakeLLM | None = None) -> RawJudgeOpinion:
    relevant = [item for item in evidence if item.sourceFamily == "community"]
    generator = llm or FakeLLM({})
    response = generator.generate(
        "community_signal",
        evidence=relevant,
        default_rationale=f"Community-signal judge evaluated {event.question}",
    )
    return RawJudgeOpinion(
        judge_name="community_signal",
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in relevant],
        warnings=[] if relevant else ["No community evidence found."],
        missing_evidence=[] if relevant else ["Expected public community discussion evidence."],
    )
