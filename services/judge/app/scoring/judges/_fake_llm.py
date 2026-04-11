"""Backwards-compatible re-export of the fake LLM used by unit tests.

The canonical implementation now lives in ``app.llm.fake``. This module keeps
the historical import path working for existing test suites.
"""
from __future__ import annotations

from app.llm.fake import FakeLLMClient as FakeLLM

__all__ = ["FakeLLM"]
