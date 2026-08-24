"""Settings, read from the environment once at import.

Defaults are chosen for the way this actually gets used: one person, on their
own machine, with gcloud already logged in. Nothing here needs to be set to run
the app locally; every value exists so the same code can also be deployed
without a rewrite.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    gcp_project: str = os.environ.get("GCP_PROJECT", "ff-python-api")
    bq_dataset: str = os.environ.get("BQ_DATASET", "projections")
    bq_table: str = os.environ.get("BQ_TABLE", "player_projections")
    bq_location: str = os.environ.get("BQ_LOCATION", "US")

    # Bound to loopback by default. This server writes to BigQuery with whatever
    # credentials the machine has, so it must not answer to the network unless
    # someone deliberately says otherwise.
    host: str = os.environ.get("HOST", "127.0.0.1")
    port: int = int(os.environ.get("PORT", "8000"))

    # Deployment-only. When set, every write must present it; when unset — the
    # local case — writes are open, because the socket is already private.
    api_token: str = os.environ.get("API_TOKEN", "")

    # Lets the UI run without a project configured: saves are refused with a
    # clear message instead of failing halfway through a BigQuery call.
    bigquery_enabled: bool = _flag("BIGQUERY_ENABLED", True)

    @property
    def table_id(self) -> str:
        return f"{self.gcp_project}.{self.bq_dataset}.{self.bq_table}"


settings = Settings()
