from __future__ import annotations

from app.scoring.judges._fake_llm import FakeLLM
from app.scoring.types import CrossExaminerResult, RawJudgeOpinion


def evaluate(
    raw_opinions: list[RawJudgeOpinion], *, llm: FakeLLM | None = None
) -> CrossExaminerResult:
    conflicts: list[dict[str, str]] = []
    warnings_by_judge = {opinion.judge_name: list(opinion.warnings) for opinion in raw_opinions}

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

    return CrossExaminerResult(conflicts=conflicts, warnings_by_judge=warnings_by_judge)
