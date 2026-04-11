from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.models_generated import (
    CalibrationSnapshot,
    EventInput,
    EvidenceItem,
    JudgeOpinion,
    OutcomeInput,
    VerdictTrace,
)


class JudgeRequest(BaseModel):
    event: EventInput
    evaluation_time: str = Field(alias="evaluationTime")
    evidence: list[EvidenceItem]
    calibration_snapshot: CalibrationSnapshot = Field(alias="calibrationSnapshot")


class CalibrationRequest(BaseModel):
    historical_traces: list[VerdictTrace] = Field(default_factory=list, alias="historicalTraces")
    resolved_outcomes: list[OutcomeInput] = Field(default_factory=list, alias="resolvedOutcomes")


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(by_alias=True, exclude_none=True)
