"""The judge writes one JSON object per log line, in the same shape as the API's logs."""

import io
import json
import logging
import logging.config
import re

import pytest
from fastapi.testclient import TestClient
from uvicorn.config import LOGGING_CONFIG

import app.api as judge_api
from app.main import app
from app.observability import ContextThreadPoolExecutor, configure_logging, request_context

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

JUDGE_REQUEST = {
    "eventId": "event-123",
    "event": {
        "question": "Will Example Corp launch Product X by 2026-12-31?",
        "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement.",
        "deadline": "2026-12-31T23:59:59Z",
        "entities": ["Example Corp", "Product X"],
        "referenceClass": "product_launch",
        "marketSymbols": [],
        "polymarketMarketId": None,
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
        "judgeWeights": {"official_records": 0.33, "community_signal": 0.33, "open_web_research": 0.34},
        "baseRateParams": {},
        "marketPriorParams": {},
        "calibrationParams": {"method": "identity"},
        "onlineLearningParams": {"enabled": False},
        "metrics": {},
        "weightRegime": "cold_start",
        "resolvedOutcomeCount": 0,
        "approved": False,
    },
}


@pytest.fixture
def log_lines():
    stream = io.StringIO()
    configure_logging(level="info", stream=stream)

    def read() -> list[dict]:
        return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]

    yield read
    configure_logging(level="info")


def test_info_lines_are_json_with_the_api_field_names(log_lines) -> None:
    logging.getLogger("app.llm.factory").info(
        "judge llm backend=%s", "openrouter", extra={"event": "judge_llm_configured", "backend": "openrouter"}
    )

    [line] = log_lines()
    assert line["level"] == "info"
    assert line["service"] == "cassandra-judge"
    assert line["scope"] == "app.llm.factory"
    assert line["event"] == "judge_llm_configured"
    assert line["backend"] == "openrouter"
    assert line["message"] == "judge llm backend=openrouter"
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", line["time"])


def test_warnings_use_the_api_level_name_and_errors_carry_the_exception(log_lines) -> None:
    logger = logging.getLogger("app.llm.openrouter")
    logger.warning("openrouter timeout", extra={"event": "openrouter_retry"})
    try:
        raise TimeoutError("read timed out")
    except TimeoutError:
        logger.exception("openrouter failed", extra={"event": "openrouter_failed"})

    warning, failure = log_lines()
    assert warning["level"] == "warn"
    assert failure["level"] == "error"
    assert failure["err"]["type"] == "TimeoutError"
    assert failure["err"]["message"] == "read timed out"
    assert "Traceback" in failure["err"]["stack"]


def test_uvicorn_server_messages_become_json_after_uvicorn_configures_logging() -> None:
    # uvicorn applies its own logging config before it imports the app; ours must win.
    logging.config.dictConfig(LOGGING_CONFIG)
    stream = io.StringIO()
    configure_logging(level="info", stream=stream)
    try:
        logging.getLogger("uvicorn.error").info("Application startup complete.")
        logging.getLogger("uvicorn.access").info('127.0.0.1 - "GET /health HTTP/1.1" 200')
    finally:
        configure_logging(level="info")

    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [line["message"] for line in lines] == ["Application startup complete."]
    assert lines[0]["scope"] == "uvicorn.error"


def test_request_lines_carry_the_callers_ids_and_echo_the_request_id(log_lines) -> None:
    client = TestClient(app)

    response = client.get(
        "/health",
        headers={"x-request-id": "req-abc", "x-cassandra-judgment-id": "judgment-1", "x-cassandra-event-id": "event-1"},
    )

    assert response.headers["x-request-id"] == "req-abc"
    completed = [line for line in log_lines() if line.get("event") == "request_completed"]
    assert len(completed) == 1
    assert completed[0]["requestId"] == "req-abc"
    assert completed[0]["judgmentId"] == "judgment-1"
    assert completed[0]["eventId"] == "event-1"
    assert completed[0]["method"] == "GET"
    assert completed[0]["path"] == "/health"
    assert completed[0]["statusCode"] == 200
    assert isinstance(completed[0]["durationMs"], float)


def test_a_missing_or_unusable_request_id_is_replaced(log_lines) -> None:
    client = TestClient(app)

    missing = client.get("/health")
    oversized = client.get("/health", headers={"x-request-id": "x" * 500})

    assert UUID_PATTERN.match(missing.headers["x-request-id"])
    assert UUID_PATTERN.match(oversized.headers["x-request-id"])
    request_ids = {line["requestId"] for line in log_lines() if line.get("event") == "request_completed"}
    assert request_ids == {missing.headers["x-request-id"], oversized.headers["x-request-id"]}


def test_pool_threads_keep_the_submitting_requests_ids(log_lines) -> None:
    with request_context(request_id="req-pool", judgment_id="judgment-9", event_id="event-9"):
        with ContextThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda n: logging.getLogger("app.llm.ensemble").info("sample %d", n), range(2)))

    lines = log_lines()
    assert len(lines) == 2
    assert {(line["requestId"], line["judgmentId"], line["eventId"]) for line in lines} == {
        ("req-pool", "judgment-9", "event-9")
    }


def test_judge_panel_logs_carry_the_request_id(log_lines, monkeypatch) -> None:
    original = judge_api.evaluate_official_records

    def logging_judge(*args, **kwargs):
        logging.getLogger("app.scoring.judges.official_records").info("official judge ran")
        return original(*args, **kwargs)

    monkeypatch.setattr(judge_api, "evaluate_official_records", logging_judge)
    client = TestClient(app)

    response = client.post("/judge", json=JUDGE_REQUEST, headers={"x-request-id": "req-judge"})

    assert response.status_code == 200
    [panel_line] = [line for line in log_lines() if line["message"] == "official judge ran"]
    assert panel_line["requestId"] == "req-judge"
