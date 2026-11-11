from __future__ import annotations

import logging
import os

from app.llm.client import LLMClient
from app.llm.ensemble import EnsembleLLMClient, parse_model_specs
from app.llm.fake import FakeLLMClient
from app.llm.openrouter import (
    DEFAULT_BASE_URL,
    DEFAULT_REASONING_EFFORT,
    DEFAULT_UTILITY_MODEL,
    DEFAULT_UTILITY_REASONING_EFFORT,
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
        logger.warning(
            "invalid integer for %s=%r; using default %d",
            name,
            value,
            default,
            extra={"event": "judge_config_invalid", "variable": name, "fallback": default},
        )
        return default


# Used when the caller sends no timeout of its own. Kept below the API's default
# JUDGE_REQUEST_TIMEOUT_MS (360 s), so the judge stops paying for model calls before the
# API stops waiting for the answer.
DEFAULT_REQUEST_BUDGET_SECONDS = 330


def _effort_env(name: str) -> str | None:
    value = (os.environ.get(name) or "").strip().lower()
    if value in {"", "default"}:
        return DEFAULT_REASONING_EFFORT
    return None if value == "off" else value


def get_llm_client(request_budget_seconds: float | None = None) -> LLMClient:
    """Return the configured LLM client, falling back to FakeLLMClient.

    Real OpenRouter calls are only made when ``CASSANDRA_JUDGE_LLM`` is set to
    ``"openrouter"`` AND a non-empty ``OPENROUTER_API_KEY`` is available. This
    makes it safe to run the test suite without hitting the network.

    ``OPENROUTER_JUDGE_MODELS`` (comma-separated, each optionally ``model@effort``)
    builds a multi-model judge ensemble; otherwise ``OPENROUTER_JUDGE_MODEL`` with
    ``OPENROUTER_JUDGE_REASONING_EFFORT`` is used as a single judge.

    ``request_budget_seconds`` is how long this request may keep calling models; the
    caller derives it from the API's own timeout. Without it, ``JUDGE_REQUEST_BUDGET_SECONDS``
    applies.
    """
    backend = (os.environ.get("CASSANDRA_JUDGE_LLM") or "fake").strip().lower()
    api_key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()

    if backend == "openrouter" and not api_key:
        logger.warning(
            "CASSANDRA_JUDGE_LLM=openrouter but OPENROUTER_API_KEY is empty; "
            "falling back to FakeLLMClient.",
            extra={"event": "judge_llm_key_missing", "backend": "fake"},
        )
    if backend != "openrouter" or not api_key:
        return FakeLLMClient()

    def env(name: str, default: str) -> str:
        return (os.environ.get(name) or default).strip() or default

    common = {
        "api_key": api_key,
        "search_model": env("OPENROUTER_SEARCH_MODEL", DEFAULT_SEARCH_MODEL),
        "base_url": env("OPENROUTER_BASE_URL", DEFAULT_BASE_URL),
        "judge_max_tokens": _int_env("OPENROUTER_JUDGE_MAX_TOKENS", DEFAULT_JUDGE_MAX_TOKENS),
        "cross_examiner_max_tokens": _int_env(
            "OPENROUTER_CROSS_EXAMINER_MAX_TOKENS", DEFAULT_CROSS_EXAMINER_MAX_TOKENS
        ),
        "search_max_tokens": _int_env("OPENROUTER_SEARCH_MAX_TOKENS", DEFAULT_SEARCH_MAX_TOKENS),
        "request_budget_seconds": (
            request_budget_seconds
            if request_budget_seconds is not None
            else float(_int_env("JUDGE_REQUEST_BUDGET_SECONDS", DEFAULT_REQUEST_BUDGET_SECONDS))
        ),
        "utility_model": env("OPENROUTER_UTILITY_MODEL", DEFAULT_UTILITY_MODEL),
        "utility_reasoning_effort": (
            (os.environ.get("OPENROUTER_UTILITY_REASONING_EFFORT") or DEFAULT_UTILITY_REASONING_EFFORT).strip().lower()
            or None
        ),
    }
    cross_model = env("OPENROUTER_CROSS_EXAMINER_MODEL", DEFAULT_CROSS_EXAMINER_MODEL)
    cross_effort = _effort_env("OPENROUTER_CROSS_EXAMINER_REASONING_EFFORT")
    specs = parse_model_specs(os.environ.get("OPENROUTER_JUDGE_MODELS") or "")
    default_effort = _effort_env("OPENROUTER_JUDGE_REASONING_EFFORT")

    if len(specs) <= 1:
        model, effort = specs[0] if specs else (env("OPENROUTER_JUDGE_MODEL", DEFAULT_JUDGE_MODEL), None)
        logger.info(
            "judge llm backend=openrouter judge_model=%s cross_model=%s",
            model,
            cross_model,
            extra={
                "event": "judge_llm_configured",
                "backend": "openrouter",
                "judgeModels": [model],
                "crossExaminerModel": cross_model,
            },
        )
        return OpenRouterLLMClient(
            judge_model=model,
            judge_reasoning_effort=effort or default_effort,
            cross_examiner_model=cross_model,
            cross_examiner_reasoning_effort=cross_effort,
            **common,
        )

    members = [
        (
            f"{model}@{effort or default_effort}" if (effort or default_effort) else model,
            OpenRouterLLMClient(
                judge_model=model,
                judge_reasoning_effort=effort or default_effort,
                cross_examiner_model=cross_model,
                cross_examiner_reasoning_effort=cross_effort,
                **common,
            ),
        )
        for model, effort in specs
    ]
    cross_examiner = OpenRouterLLMClient(
        judge_model=cross_model,
        cross_examiner_model=cross_model,
        cross_examiner_reasoning_effort=cross_effort,
        **common,
    )
    logger.info(
        "judge llm backend=openrouter ensemble=%s cross_model=%s",
        [name for name, _ in members],
        cross_model,
        extra={
            "event": "judge_llm_configured",
            "backend": "openrouter",
            "judgeModels": [name for name, _ in members],
            "crossExaminerModel": cross_model,
        },
    )
    return EnsembleLLMClient(members, cross_examiner=cross_examiner, utility=cross_examiner)
