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
