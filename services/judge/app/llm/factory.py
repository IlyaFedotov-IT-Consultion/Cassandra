from __future__ import annotations

import logging
import os

from app.llm.client import LLMClient
from app.llm.fake import FakeLLMClient
from app.llm.openrouter import (
    DEFAULT_BASE_URL,
    DEFAULT_CROSS_EXAMINER_MODEL,
    DEFAULT_CROSS_EXAMINER_MAX_TOKENS,
    DEFAULT_JUDGE_MODEL,
    DEFAULT_JUDGE_MAX_TOKENS,
    DEFAULT_SEARCH_MODEL,
    DEFAULT_SEARCH_MAX_TOKENS,
    OpenRouterLLMClient,
)

logger = logging.getLogger(__name__)


def _int_env(name: str, default: int) -> int:
    value = (os.environ.get(name) or "").strip()
    if not value:
        return default
    try:
        return max(1, int(value))
    except ValueError:
        logger.warning("invalid integer for %s=%r; using default %d", name, value, default)
        return default


def get_llm_client() -> LLMClient:
    """Return the configured LLM client, falling back to FakeLLMClient.

    Real OpenRouter calls are only made when ``CASSANDRA_JUDGE_LLM`` is set to
    ``"openrouter"`` AND a non-empty ``OPENROUTER_API_KEY`` is available. This
    makes it safe to run the test suite without hitting the network.
    """
    backend = (os.environ.get("CASSANDRA_JUDGE_LLM") or "fake").strip().lower()
    api_key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()

    if backend == "openrouter" and api_key:
        judge_model = (
            os.environ.get("OPENROUTER_JUDGE_MODEL") or DEFAULT_JUDGE_MODEL
        ).strip() or DEFAULT_JUDGE_MODEL
        cross_model = (
            os.environ.get("OPENROUTER_CROSS_EXAMINER_MODEL")
            or DEFAULT_CROSS_EXAMINER_MODEL
        ).strip() or DEFAULT_CROSS_EXAMINER_MODEL
        search_model = (
            os.environ.get("OPENROUTER_SEARCH_MODEL") or DEFAULT_SEARCH_MODEL
        ).strip() or DEFAULT_SEARCH_MODEL
        base_url = (
            os.environ.get("OPENROUTER_BASE_URL") or DEFAULT_BASE_URL
        ).strip() or DEFAULT_BASE_URL
        judge_max_tokens = _int_env("OPENROUTER_JUDGE_MAX_TOKENS", DEFAULT_JUDGE_MAX_TOKENS)
        cross_max_tokens = _int_env(
            "OPENROUTER_CROSS_EXAMINER_MAX_TOKENS",
            DEFAULT_CROSS_EXAMINER_MAX_TOKENS,
        )
        search_max_tokens = _int_env("OPENROUTER_SEARCH_MAX_TOKENS", DEFAULT_SEARCH_MAX_TOKENS)
        logger.info(
            "judge llm backend=openrouter judge_model=%s cross_model=%s search_model=%s judge_max_tokens=%d cross_max_tokens=%d search_max_tokens=%d",
            judge_model,
            cross_model,
            search_model,
            judge_max_tokens,
            cross_max_tokens,
            search_max_tokens,
        )
        return OpenRouterLLMClient(
            api_key=api_key,
            judge_model=judge_model,
            cross_examiner_model=cross_model,
            search_model=search_model,
            base_url=base_url,
            judge_max_tokens=judge_max_tokens,
            cross_examiner_max_tokens=cross_max_tokens,
            search_max_tokens=search_max_tokens,
        )

    if backend == "openrouter" and not api_key:
        logger.warning(
            "CASSANDRA_JUDGE_LLM=openrouter but OPENROUTER_API_KEY is empty; "
            "falling back to FakeLLMClient."
        )

    return FakeLLMClient()
