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
    event_id: str = Field(alias="eventId")
    event: EventInput
    evaluation_time: str = Field(alias="evaluationTime")
    evidence: list[EvidenceItem]
    calibration_snapshot: CalibrationSnapshot = Field(alias="calibrationSnapshot")
    prior_only: bool = Field(default=False, alias="priorOnly")


class PlanRequest(BaseModel):
    event: EventInput
    evaluation_time: str | None = Field(default=None, alias="evaluationTime")
    max_queries: int = Field(default=4, alias="maxQueries", ge=1, le=8)


class MarketPricePair(BaseModel):
    """A resolved benchmark market's price at one cutoff, with how the market resolved."""

    price: float
    outcome: bool


class CalibrationRequest(BaseModel):
    historical_traces: list[VerdictTrace] = Field(default_factory=list, alias="historicalTraces")
    resolved_outcomes: list[OutcomeInput] = Field(default_factory=list, alias="resolvedOutcomes")
    market_price_pairs: list[MarketPricePair] = Field(default_factory=list, alias="marketPricePairs")


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(by_alias=True, exclude_none=True)
