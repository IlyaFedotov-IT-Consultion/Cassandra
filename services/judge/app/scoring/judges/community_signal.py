from __future__ import annotations

from app.llm.client import LLMClient
from app.models_generated import EventInput, EvidenceItem
from app.scoring.judges._panel import run_panel_judge
from app.scoring.types import RawJudgeOpinion

SOURCE_FAMILIES = {"community"}


def evaluate(
    event: EventInput,
    evidence: list[EvidenceItem],
    *,
    llm: LLMClient | None = None,
    evaluation_time: str | None = None,
) -> RawJudgeOpinion:
    return run_panel_judge(
        judge_name="community_signal",
        event=event,
        relevant=[item for item in evidence if item.sourceFamily in SOURCE_FAMILIES],
        llm=llm,
        evaluation_time=evaluation_time,
        no_evidence_warning="No community evidence found.",
        missing_evidence="Expected public community discussion evidence.",
    )
