from math import exp, log

from fastapi.testclient import TestClient

from app.api import _llm_dependency
from app.main import app
from app.llm.fake import FakeLLMClient


client = TestClient(app)


def test_health_endpoint_returns_ok() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_judge_endpoint_validates_and_returns_trace_shape() -> None:
    response = client.post(
        "/judge",
        json={
            "eventId": "event-123",
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
    assert payload["eventId"] == "event-123"
    assert payload["judgeOpinions"]
    assert payload["citations"]
    assert payload["calibrationVersion"] == "33333333-3333-4333-8333-333333333333"


def test_judge_endpoint_applies_calibration_map_to_final_probability() -> None:
    app.dependency_overrides[_llm_dependency] = lambda: FakeLLMClient({})
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-calibrated",
                "event": {
                    "question": "Will Example Corp launch Product X by 2026-12-31?",
                    "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
                    "deadline": "2026-12-31T23:59:59Z",
                    "entities": ["Example Corp", "Product X"],
                    "referenceClass": "product_launch",
                    "marketSymbols": ["EXMPL"],
                },
                "evaluationTime": "2026-10-11T12:00:00Z",
                "evidence": [],
                "calibrationSnapshot": {
                    "id": "snapshot-calibrated",
                    "createdAt": "2026-10-01T00:00:00Z",
                    "trainingWindow": "all_time",
                    "judgeWeights": {
                        "official_records": 0.33,
                        "community_signal": 0.33,
                        "open_web_research": 0.34,
                    },
                    "baseRateParams": {},
                    "marketPriorParams": {},
                    "calibrationParams": {
                        "method": "logistic",
                        "slope": 1.0,
                        "intercept": 1.0,
                    },
                    "onlineLearningParams": {"enabled": False},
                    "metrics": {},
                    "weightRegime": "cold_start",
                    "resolvedOutcomeCount": 0,
                    "approved": False,
                },
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["rawPosteriorProbability"] == 0.5
    assert payload["finalProbability"] > payload["rawPosteriorProbability"]


def test_judge_endpoint_reports_the_blended_prior_probability() -> None:
    app.dependency_overrides[_llm_dependency] = lambda: FakeLLMClient({})
    try:
        response = client.post(
            "/judge",
            json={
                "eventId": "event-prior",
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
                        "id": "market-1",
                        "eventId": "event-prior",
                        "sourceFamily": "prediction_market",
                        "sourceType": "quote_snapshot",
                        "title": "Example market snapshot",
                        "url": "https://markets.example.com/product-x",
                        "publisher": "Example Markets",
                        "publishedAt": "2026-10-10T09:00:00Z",
                        "retrievedAt": "2026-10-11T12:00:00Z",
                        "summary": "Market odds imply a likely launch.",
                        "rawText": None,
                        "entities": ["Example Corp", "Product X"],
                        "claims": ["Product X likely launches this year"],
                        "stance": "supports",
                        "qualitySignals": {},
                        "metadata": {
                            "price": 0.7,
                            "spread": 0.05,
                            "depth": 50000,
                            "volatility": 0.1,
                        },
                    }
                ],
                "calibrationSnapshot": {
                    "id": "snapshot-prior",
                    "createdAt": "2026-10-01T00:00:00Z",
                    "trainingWindow": "all_time",
                    "judgeWeights": {
                        "official_records": 0.33,
                        "community_signal": 0.33,
                        "open_web_research": 0.34,
                    },
                    "baseRateParams": {
                        "minimumSample": 20,
                        "historicalCounts": {
                            "product_launch": {
                                "successes": 15,
                                "total": 20,
                            }
                        },
                    },
                    "marketPriorParams": {
                        "defaultAlpha": 0.6,
                    },
                    "calibrationParams": {"method": "identity"},
                    "onlineLearningParams": {"enabled": False},
                    "metrics": {},
                    "weightRegime": "cold_start",
                    "resolvedOutcomeCount": 0,
                    "approved": False,
                },
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    base_rate_probability = (15 + 1) / (20 + 2)
    market_probability = 0.5 + (
        min(max((1 - 0.05) * (1 - 0.1) * (1 - exp(-50000 / 50000)), 0.0), 1.0) * (0.7 - 0.5)
    )
    expected_prior = 1 / (
        1
        + exp(
            -(
                0.6 * log(base_rate_probability / (1 - base_rate_probability))
                + 0.4 * log(market_probability / (1 - market_probability))
            )
        )
    )

    assert abs(payload["priorProbability"] - expected_prior) < 1e-6


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
            "eventId": "event-panel",
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


def test_judge_endpoint_prioritizes_english_citations() -> None:
    response = client.post(
        "/judge",
        json={
            "eventId": "event-citation-priority",
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
                    "id": "zh-web-1",
                    "eventId": "event-citation-priority",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "示例公司将在年底前发布产品",
                    "url": "https://news.example.cn/product-x",
                    "publisher": "示例财经",
                    "publishedAt": "2026-10-10T09:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "市场传言称产品发布临近。",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                },
                {
                    "id": "en-web-1",
                    "eventId": "event-citation-priority",
                    "sourceFamily": "web",
                    "sourceType": "web_article",
                    "title": "Example Corp says Product X launch remains on track",
                    "url": "https://news.example.com/product-x",
                    "publisher": "Example News",
                    "publishedAt": "2026-10-10T08:00:00Z",
                    "retrievedAt": "2026-10-11T12:00:00Z",
                    "summary": "English-language reporting indicates a launch is still expected this year.",
                    "rawText": None,
                    "entities": ["Example Corp", "Product X"],
                    "claims": ["Product X may launch this year"],
                    "stance": "supports",
                    "qualitySignals": {},
                    "metadata": {},
                },
            ],
            "calibrationSnapshot": {
                "id": "snapshot-citation-priority",
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
    assert payload["citations"][0]["url"] == "https://news.example.com/product-x"
