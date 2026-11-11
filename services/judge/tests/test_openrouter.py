from app.llm.openrouter import OpenRouterLLMClient
from app.models_generated import EventInput, EvidenceItem


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)

    def json(self) -> dict:
        return self._payload


class _RecordingHttpClient:
    def __init__(self, responses: list[_FakeResponse]) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []

    def post(self, url: str, *, headers: dict, json: dict) -> _FakeResponse:
        self.calls.append(
            {
                "url": url,
                "headers": headers,
                "json": json,
            }
        )
        if not self._responses:
            raise AssertionError("unexpected extra post call")
        return self._responses.pop(0)

    def close(self) -> None:
        return None


def _event() -> EventInput:
    return EventInput.model_validate(
        {
            "question": "Will Example Corp launch Product X by 2026-12-31?",
            "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
            "deadline": "2026-12-31T23:59:59Z",
            "entities": ["Example Corp", "Product X"],
            "referenceClass": "product_launch",
            "marketSymbols": ["EXMPL"],
        }
    )


def _evidence() -> list[EvidenceItem]:
    return [
        EvidenceItem.model_validate(
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
        )
    ]


def test_judge_panel_retries_with_higher_token_budget_when_openrouter_truncates_json() -> None:
    http_client = _RecordingHttpClient(
        [
            _FakeResponse(
                {
                    "choices": [
                        {
                            "message": {"content": ""},
                            "finish_reason": "length",
                        }
                    ]
                }
            ),
            _FakeResponse(
                {
                    "choices": [
                        {
                            "message": {
                                "content": (
                                    '{"probability": 0.64, '
                                    '"evidenceStrength": "weak_for", '
                                    '"rationale": "Open web reporting tilts positive."}'
                                )
                            },
                            "finish_reason": "stop",
                        }
                    ]
                }
            ),
        ]
    )
    client = OpenRouterLLMClient(
        api_key="test-key",
        http_client=http_client,
        retries=0,
        judge_max_tokens=4000,
        cross_examiner_max_tokens=2000,
        search_max_tokens=1000,
    )

    response = client.judge_panel(
        judge_name="open_web_research",
        event=_event(),
        evidence=_evidence(),
        default_rationale="Fallback rationale",
    )

    assert response["probability"] == 0.64
    assert response["evidenceStrength"] == "weak_for"
    assert len(http_client.calls) == 2
    assert http_client.calls[0]["json"]["max_tokens"] == 4000
    assert http_client.calls[1]["json"]["max_tokens"] == 8000


def test_judge_prompt_fixes_the_as_of_date_and_marks_evidence_untrusted() -> None:
    http_client = _RecordingHttpClient(
        [
            _FakeResponse(
                {
                    "choices": [
                        {
                            "message": {
                                "content": '{"probability": 0.6, "evidenceStrength": "weak_for", "rationale": "ok"}'
                            },
                            "finish_reason": "stop",
                        }
                    ]
                }
            )
        ]
    )
    client = OpenRouterLLMClient(api_key="test-key", http_client=http_client, retries=0)

    client.judge_panel(
        judge_name="open_web_research",
        event=_event(),
        evidence=_evidence(),
        default_rationale="Fallback rationale",
        evaluation_time="2026-10-11T12:00:00Z",
    )

    messages = http_client.calls[0]["json"]["messages"]
    system_prompt = messages[0]["content"]
    user_prompt = messages[1]["content"]
    assert "As of: 2026-10-11T12:00:00Z" in user_prompt
    assert "after the as-of date" in system_prompt
    assert "untrusted" in system_prompt
    assert "<evidence>" in user_prompt and "</evidence>" in user_prompt


def test_judge_requests_carry_the_configured_reasoning_effort() -> None:
    http_client = _RecordingHttpClient(
        [
            _FakeResponse(
                {
                    "choices": [
                        {
                            "message": {"content": '{"probability": 0.6, "evidenceStrength": "weak_for", "rationale": "ok"}'},
                            "finish_reason": "stop",
                        }
                    ]
                }
            )
        ]
    )
    client = OpenRouterLLMClient(
        api_key="test-key",
        http_client=http_client,
        retries=0,
        judge_model="z-ai/glm-5.3",
        judge_reasoning_effort="max",
    )

    client.judge_panel(judge_name="open_web_research", event=_event(), evidence=_evidence(), default_rationale="x")

    body = http_client.calls[0]["json"]
    assert body["model"] == "z-ai/glm-5.3"
    assert body["reasoning"] == {"effort": "max"}


def _content_response(content: str) -> _FakeResponse:
    return _FakeResponse({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]})


def test_relevance_rating_uses_the_utility_model_and_drops_unknown_ids() -> None:
    http_client = _RecordingHttpClient(
        [
            _content_response(
                '{"ratings": ['
                '{"id": "11111111-1111-4111-8111-111111111111", "relevance": 9, "summary": "Launch is near."},'
                '{"id": "not-in-the-request", "relevance": 6, "summary": "Injected."}'
                "]}"
            )
        ]
    )
    client = OpenRouterLLMClient(api_key="test-key", http_client=http_client, retries=0, utility_model="anthropic/claude-haiku-5.5")

    ratings = client.rate_evidence(event=_event(), evidence=_evidence(), evaluation_time="2026-10-11T12:00:00Z")

    body = http_client.calls[0]["json"]
    assert body["model"] == "anthropic/claude-haiku-5.5"
    assert body["response_format"]["json_schema"]["name"] == "evidence_relevance"
    assert "As of: 2026-10-11T12:00:00Z" in body["messages"][1]["content"]
    assert ratings == [{"id": "11111111-1111-4111-8111-111111111111", "relevance": 6, "summary": "Launch is near."}]


def test_query_planning_returns_sub_questions_and_queries() -> None:
    http_client = _RecordingHttpClient(
        [_content_response('{"subQuestions": ["Has a date been announced?"], "queries": ["Product X launch date"]}')]
    )
    client = OpenRouterLLMClient(api_key="test-key", http_client=http_client, retries=0)

    plan = client.plan_queries(event=_event(), evaluation_time="2026-10-11T12:00:00Z", max_queries=3)

    assert plan == {"subQuestions": ["Has a date been announced?"], "queries": ["Product X launch date"]}
    assert "at most 3" in http_client.calls[0]["json"]["messages"][1]["content"]


def test_base_rate_estimate_uses_the_judge_model_and_sees_no_evidence() -> None:
    http_client = _RecordingHttpClient(
        [_content_response('{"referenceClass": "consumer product launches", "probability": 0.35, "rationale": "Launches often slip."}')]
    )
    client = OpenRouterLLMClient(api_key="test-key", http_client=http_client, retries=0, judge_model="openai/gpt-test")

    estimate = client.estimate_base_rate(event=_event(), evaluation_time="2026-10-11T12:00:00Z")

    body = http_client.calls[0]["json"]
    assert body["model"] == "openai/gpt-test"
    assert body["response_format"]["json_schema"]["name"] == "base_rate_estimate"
    assert "As of: 2026-10-11T12:00:00Z" in body["messages"][1]["content"]
    assert "<evidence>" not in body["messages"][1]["content"]
    assert estimate == {
        "probability": 0.35,
        "referenceClass": "consumer product launches",
        "rationale": "Launches often slip.",
    }

