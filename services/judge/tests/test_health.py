from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_endpoint_returns_ok() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_judge_endpoint_validates_and_returns_trace_shape() -> None:
    response = client.post(
        "/judge",
        json={
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": ["EXMPL"],
                "polymarketMarketId": "poly-1",
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "eventId": "22222222-2222-4222-8222-222222222222",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example report",
                    "url": "https://news.example.com/product-x",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "Several reports suggest a launch is close.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                }
            ],
            "calibrationSnapshot": {
                "id": "33333333-3333-4333-8333-333333333333",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {
                    "official_records": 0.33,
                    "community_signal": 0.33,
                    "open_web_research": 0.34,
                },
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {"enabled": False},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["judgeOpinions"]
    assert payload["citations"]
    assert payload["calibrationVersion"] == "33333333-3333-4333-8333-333333333333"


def test_judge_endpoint_rejects_invalid_payload() -> None:
    response = client.post(
        "/judge",
        json={
            "event": {
                "question": "",
            }
        },
    )

    assert response.status_code == 422


def test_judge_endpoint_runs_full_panel_and_reports_missing_families() -> None:
    response = client.post(
        "/judge",
        json={
            "event": {
                "question": "Will Example Corp launch Product X by 2026-12-31?",
                "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                "deadline": "2026-12-31T23:59:59Z",
                "entities": ["Example Corp", "Product X"],
                "referenceClass": "product_launch",
                "marketSymbols": ["EXMPL"],
            },
            "evaluationTime": "2026-10-11T12:00:00Z",
            "evidence": [
                {
                    "id": "web-1",
                    "eventId": "event-1",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example web report",
                    "url": "https://news.example.com/product-x-web",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "Web reporting suggests a launch is close.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                }
            ],
            "calibrationSnapshot": {
                "id": "snapshot-panel",
                "createdAt": "2026-10-01T00:00:00Z",
                "trainingWindow": "all_time",
                "judgeWeights": {
                    "official_records": 0.33,
                    "community_signal": 0.33,
                    "open_web_research": 0.34,
                },
                "baseRateParams": {},
                "marketPriorParams": {},
                "calibrationParams": {"method": "identity"},
                "onlineLearningParams": {"enabled": False},
                "metrics": {},
                "weightRegime": "cold_start",
                "resolvedOutcomeCount": 0,
                "approved": False,
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    judge_names = {opinion["judgeName"] for opinion in payload["judgeOpinions"]}
    missing_families = {item["sourceFamily"] for item in payload["missingEvidence"]}

    assert judge_names == {"official_records", "community_signal", "open_web_research"}
    assert {"official", "community"} <= missing_families
