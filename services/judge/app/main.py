from fastapi import FastAPI

from app.api import router
from app.observability import RequestContextMiddleware, configure_logging


# uvicorn sets up its own logging before importing this module, so this call takes over.
configure_logging()

app = FastAPI(title="Cassandra Judge Service", version="0.1.0")
app.add_middleware(RequestContextMiddleware)
app.include_router(router)
