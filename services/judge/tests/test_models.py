from pathlib import Path
from subprocess import run

from app.models import CalibrationRequest, JudgeRequest


ROOT = Path(__file__).resolve().parents[1]
GENERATE_SCRIPT = ROOT / "scripts" / "generate-models.sh"
GENERATED_MODELS = ROOT / "app" / "models_generated.py"


def test_generated_request_models_accept_shared_schema_payloads() -> None:
    judge_request = JudgeRequest.model_validate(
        {
            "eventId": "event-1",
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": [],
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [],
            "calibrationSnapshot": {
                "id": "33333333-3333-4333-8333-333333333333",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {},
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        }
    )
    calibration_request = CalibrationRequest.model_validate(
        {
            "historicalTraces": [],
            "resolvedOutcomes": [],
        }
    )

    assert judge_request.event.question.startswith("Will Example Corp")
    assert calibration_request.historical_traces == []


def test_generated_models_match_regenerated_output(tmp_path: Path) -> None:
    output_path = tmp_path / "models_generated.py"
    result = run(
        [str(GENERATE_SCRIPT), str(output_path)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert output_path.read_text() == GENERATED_MODELS.read_text()
