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
    relevant = [item for item in evidence if item.sourceFamily in {"official", "government"}]
    client = llm or FakeLLMClient()
    response = client.judge_panel(
        judge_name="official_records",
        event=event,
        evidence=relevant,
        default_rationale=f"Official-records judge evaluated {event.question}",
    )
    return RawJudgeOpinion(
        judge_name="official_records",
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in relevant],
        warnings=[] if relevant else ["No official or government evidence found."],
        missing_evidence=[] if relevant else ["Expected official or government evidence."],
    )
