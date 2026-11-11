"""Structured JSON logging for the judge service.

Every line is one JSON object with the same field names as the API's pino logs
(`level`, `time`, `service`, `scope`, `event`, `message`), plus the ids the API sends
with each call (`requestId`, `judgmentId`, `eventId`) so the two services' logs join up.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import sys
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, TextIO

SERVICE_NAME = "cassandra-judge"

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)
_judgment_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("judgment_id", default=None)
_event_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("event_id", default=None)
_CONTEXT_FIELDS = (("requestId", _request_id), ("judgmentId", _judgment_id), ("eventId", _event_id))

# pino's level names, so one log query works across both services.
_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "fatal",
}

# Attributes every LogRecord has; anything else on a record came from `extra=` and is logged.
_RECORD_ATTRIBUTES = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
    "taskName",
    "color_message",  # uvicorn's ANSI-coloured copy of the message
}

_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_HANDLER_FLAG = "_cassandra_json_handler"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "service": SERVICE_NAME,
            "scope": record.name,
        }

        for field, variable in _CONTEXT_FIELDS:
            value = variable.get()
            if value:
                payload[field] = value

        for key, value in vars(record).items():
            if key not in _RECORD_ATTRIBUTES and not key.startswith("_") and key not in payload:
                payload[key] = value

        if record.exc_info and record.exc_info[0] is not None:
            error_type, error, _ = record.exc_info
            payload["err"] = {
                "type": error_type.__name__,
                "message": str(error),
                "stack": self.formatException(record.exc_info),
            }

        payload["message"] = record.getMessage()
        return json.dumps(payload, default=str, separators=(",", ":"))


class _CurrentStdout:
    """Writes to whatever `sys.stdout` is at the time, so a replaced stdout (test capture) still works."""

    def write(self, text: str) -> int:
        return sys.stdout.write(text)

    def flush(self) -> None:
        sys.stdout.flush()


def _resolve_level(level: str | None) -> int:
    name = (level or os.environ.get("LOG_LEVEL") or "info").strip().lower()
    if name == "silent":
        return logging.CRITICAL + 10
    numeric = logging.getLevelName({"warn": "WARNING", "fatal": "CRITICAL"}.get(name, name.upper()))
    return numeric if isinstance(numeric, int) else logging.INFO


def configure_logging(level: str | None = None, stream: TextIO | None = None) -> logging.Handler:
    """Send every logger, uvicorn's included, through one JSON handler.

    `level` defaults to `LOG_LEVEL` (the same variable the API reads), then `info`. Safe to
    call again: it replaces the handler it installed before.
    """
    handler = logging.StreamHandler(stream if stream is not None else _CurrentStdout())
    handler.setFormatter(JsonFormatter())
    setattr(handler, _HANDLER_FLAG, True)

    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, _HANDLER_FLAG, False):
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(_resolve_level(level))

    # uvicorn installs plain-text handlers on its own loggers before it imports the app.
    # Its server messages go through the JSON handler instead; its access lines are
    # replaced by RequestContextMiddleware's request_completed events.
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers = []
    access_logger.propagate = False
    access_logger.disabled = True

    return handler


@contextmanager
def request_context(
    request_id: str | None, judgment_id: str | None = None, event_id: str | None = None
) -> Iterator[None]:
    """Bind ids that every log line written inside the block (and its pool threads) carries."""
    tokens = [
        (_request_id, _request_id.set(request_id)),
        (_judgment_id, _judgment_id.set(judgment_id)),
        (_event_id, _event_id.set(event_id)),
    ]
    try:
        yield
    finally:
        for variable, token in reversed(tokens):
            variable.reset(token)


class ContextThreadPoolExecutor(ThreadPoolExecutor):
    """A thread pool whose tasks see the submitting thread's context, so pool logs keep their ids.

    A plain ThreadPoolExecutor runs tasks with an empty context: log lines written from
    the judge panel or the model ensemble would lose the request's ids.
    """

    def submit(self, fn, /, *args, **kwargs):  # type: ignore[override]
        return super().submit(contextvars.copy_context().run, fn, *args, **kwargs)


def _clean_id(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value if _SAFE_ID.match(value) else None


class RequestContextMiddleware:
    """Binds the caller's ids for the request and logs its start and end.

    Reads `x-request-id` (generated when missing or unusable), `x-cassandra-judgment-id`
    and `x-cassandra-event-id`, and echoes the request id in the response.
    """

    def __init__(self, app) -> None:
        self.app = app
        self.logger = logging.getLogger("app.http")

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope["headers"]}
        request_id = _clean_id(headers.get("x-request-id")) or str(uuid.uuid4())
        request_fields = {"method": scope["method"], "path": scope["path"]}
        status_code = 500
        started = time.perf_counter()

        async def send_with_request_id(message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                message = {
                    **message,
                    "headers": [*message.get("headers", []), (b"x-request-id", request_id.encode("latin-1"))],
                }
            await send(message)

        with request_context(
            request_id,
            _clean_id(headers.get("x-cassandra-judgment-id")),
            _clean_id(headers.get("x-cassandra-event-id")),
        ):
            self.logger.info("request received", extra={"event": "request_received", **request_fields})
            try:
                await self.app(scope, receive, send_with_request_id)
            except Exception:
                self.logger.exception("request failed", extra={"event": "request_failed", **request_fields})
                raise
            finally:
                self.logger.info(
                    "request completed",
                    extra={
                        "event": "request_completed",
                        **request_fields,
                        "statusCode": status_code,
                        "durationMs": round((time.perf_counter() - started) * 1000, 3),
                    },
                )
