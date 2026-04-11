from __future__ import annotations

from app.llm.client import LLMClient
from app.llm.fake import FakeLLMClient
from app.scoring.types import CrossExaminerResult, RawJudgeOpinion


def evaluate(
    raw_opinions: list[RawJudgeOpinion],
    *,
    llm: LLMClient | None = None,
) -> CrossExaminerResult:
    warnings_by_judge = {opinion.judge_name: list(opinion.warnings) for opinion in raw_opinions}
    client = llm or FakeLLMClient()
    response = client.cross_examine(raw_opinions=raw_opinions)
    conflicts = list(response.get("conflicts", []))
    return CrossExaminerResult(conflicts=conflicts, warnings_by_judge=warnings_by_judge)
