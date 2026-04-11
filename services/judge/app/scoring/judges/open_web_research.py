from __future__ import annotations

from app.llm.client import LLMClient
from app.llm.fake import FakeLLMClient
from app.models_generated import EventInput, EvidenceItem
from app.scoring.types import RawJudgeOpinion


def _synthesize_search_evidence(
    event: EventInput,
    client: LLMClient,
) -> tuple[str, list[str]]:
    """Run a grounded web search and return (summary_text, citation_urls)."""
    query = (
        f"Latest news and analysis bearing on this forecasting question: "
        f"{event.question}. Resolution criteria: {event.resolutionCriteria}. "
        f"Focus on evidence that affects the probability of the event resolving true."
    )
    result = client.search_web(query=query)
    citations = [
        citation.get("url")
        for citation in result.get("citations", [])
        if citation.get("url")
    ]
    return result.get("content", ""), [url for url in citations if url]


def evaluate(
    event: EventInput,
    evidence: list[EvidenceItem],
    *,
    llm: LLMClient | None = None,
) -> RawJudgeOpinion:
    relevant = [
        item
        for item in evidence
        if item.sourceFamily in {"web", "llm_research"}
    ]
    client = llm or FakeLLMClient()
    warnings: list[str] = []
    search_summary = ""
    search_citations: list[str] = []
    try:
        search_summary, search_citations = _synthesize_search_evidence(event, client)
    except Exception as exc:  # noqa: BLE001 - we classify below
        warnings.append(f"Web search step failed: {exc}")

    panel_evidence = list(relevant)
    if search_summary:
        synthetic = EvidenceItem.model_validate(
            {
                "id": f"search-synth-{abs(hash(search_summary)) % 10_000_000}",
                "eventId": "search-synth",
                "sourceFamily": "llm_research",
                "sourceType": "perplexity_search_result",
                "title": f"Search summary for: {event.question}",
                "url": search_citations[0] if search_citations else "https://openrouter.ai/synthetic",
                "publisher": "openrouter:perplexity/sonar",
                "publishedAt": "1970-01-01T00:00:00Z",
                "retrievedAt": "1970-01-01T00:00:00Z",
                "summary": search_summary[:2000],
                "rawText": search_summary[:8000],
                "entities": [str(entity) for entity in event.entities],
                "claims": [],
                "stance": "unknown",
                "qualitySignals": {"citationCount": len(search_citations)},
                "metadata": {"citations": search_citations},
            }
        )
        panel_evidence.append(synthetic)

    response = client.judge_panel(
        judge_name="open_web_research",
        event=event,
        evidence=panel_evidence,
        default_rationale=f"Open-web judge evaluated {event.question}",
    )

    if not relevant and not search_summary:
        warnings.append("No open-web or search evidence was available.")
    missing = [] if (relevant or search_summary) else [
        "Expected open web or research evidence."
    ]

    return RawJudgeOpinion(
        judge_name="open_web_research",
        probability=float(response["probability"]),
        evidence_strength=str(response["evidenceStrength"]),
        rationale=str(response["rationale"]),
        evidence_ids=[item.id for item in panel_evidence],
        warnings=warnings,
        missing_evidence=missing,
    )
