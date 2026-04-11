from __future__ import annotations

from typing import Any

from app.models_generated import EvidenceItem


class FakeLLM:
    def __init__(self, responses: dict[str, dict[str, Any]]) -> None:
        self._responses = responses

    def generate(
        self,
        judge_name: str,
        *,
        evidence: list[EvidenceItem],
        default_rationale: str,
    ) -> dict[str, Any]:
        if judge_name in self._responses:
            return dict(self._responses[judge_name])

        support = sum(1 for item in evidence if item.stance == "supports")
        contradict = sum(1 for item in evidence if item.stance == "contradicts")
        score = support - contradict

        if score >= 2:
            strength = "moderate_for"
            probability = 0.7
        elif score == 1:
            strength = "weak_for"
            probability = 0.6
        elif score <= -2:
            strength = "moderate_against"
            probability = 0.3
        elif score == -1:
            strength = "weak_against"
            probability = 0.4
        else:
            strength = "neutral"
            probability = 0.5

        return {
            "probability": probability,
            "evidenceStrength": strength,
            "rationale": default_rationale,
        }
