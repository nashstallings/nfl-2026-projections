"""Reading and writing projection sets in BigQuery.

Saves are append-only. Each click of Save writes one row per projected player
under a fresh ``save_id``, and nothing is ever updated in place — so the table
holds the history of what you believed and when, which is the part that turns
out to be interesting in February. "Current" is just the newest ``save_id``.

The client is created lazily. Importing this module must not require
credentials, or the dashboard could not start on a machine that has none.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)

# Written per player. Inputs (shares, team volume) sit alongside outputs (the
# stat line and its points) so a row explains itself without a join back to a
# baseline file that may since have been rebuilt.
ROW_FIELDS = (
    "saved_at", "save_id", "label", "projection_season", "team",
    "player_id", "player", "position", "games",
    "share_pass", "share_rush", "share_recv",
    "team_pass_attempts", "team_carries", "team_targets",
    "pass_attempts", "completions", "passing_yards", "passing_tds", "interceptions",
    "carries", "rushing_yards", "rushing_tds",
    "targets", "receptions", "receiving_yards", "receiving_tds", "fumbles_lost",
    "fantasy_points_std", "fantasy_points_half_ppr", "fantasy_points_ppr",
)


class StoreError(RuntimeError):
    """The projection could not be stored or retrieved."""


_client = None


def client():
    global _client
    if _client is None:
        try:
            from google.cloud import bigquery
        except ImportError as exc:  # pragma: no cover - import guard
            raise StoreError(
                "google-cloud-bigquery is not installed — run "
                "`pip install -r requirements.txt`"
            ) from exc
        try:
            _client = bigquery.Client(project=settings.gcp_project)
        except Exception as exc:
            raise StoreError(
                "could not create a BigQuery client. Run "
                "`gcloud auth application-default login` first."
            ) from exc
    return _client


def _number(value: Any, places: int = 2) -> float:
    try:
        return round(float(value), places)
    except (TypeError, ValueError):
        return 0.0


def flatten(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn one Save into the rows that represent it.

    The payload is what the browser holds: a projection season, an optional
    label, and a list of teams each carrying its 2026 volume and its projected
    players. One row comes back per player.
    """
    saved_at = datetime.now(UTC).isoformat()
    save_id = str(uuid.uuid4())
    season = int(payload.get("projection_season") or 0)
    label = str(payload.get("label") or "")[:200]

    rows: list[dict[str, Any]] = []
    for team in payload.get("teams") or []:
        volume = team.get("volume") or {}
        for player in team.get("players") or []:
            stats = player.get("stats") or {}
            points = player.get("points") or {}
            shares = player.get("shares") or {}
            rows.append(
                {
                    "saved_at": saved_at,
                    "save_id": save_id,
                    "label": label,
                    "projection_season": season,
                    "team": str(team.get("team") or ""),
                    "player_id": str(player.get("player_id") or ""),
                    "player": str(player.get("player") or ""),
                    "position": str(player.get("position") or ""),
                    "games": int(player.get("games") or 0),
                    "share_pass": _number(shares.get("pass"), 6),
                    "share_rush": _number(shares.get("rush"), 6),
                    "share_recv": _number(shares.get("recv"), 6),
                    "team_pass_attempts": int(_number(volume.get("pass_attempts"), 0)),
                    "team_carries": int(_number(volume.get("carries"), 0)),
                    "team_targets": int(_number(volume.get("targets"), 0)),
                    **{
                        stat: _number(stats.get(stat), 2)
                        for stat in (
                            "pass_attempts", "completions", "passing_yards",
                            "passing_tds", "interceptions", "carries",
                            "rushing_yards", "rushing_tds", "targets", "receptions",
                            "receiving_yards", "receiving_tds", "fumbles_lost",
                        )
                    },
                    "fantasy_points_std": _number(points.get("std")),
                    "fantasy_points_half_ppr": _number(points.get("half_ppr")),
                    "fantasy_points_ppr": _number(points.get("ppr")),
                }
            )
    if not rows:
        raise StoreError("nothing to save — no projected players in the payload")
    return rows


def save(payload: dict[str, Any]) -> dict[str, Any]:
    """Append one projection set. Returns the save id and row count."""
    rows = flatten(payload)
    errors = client().insert_rows_json(settings.table_id, rows)
    if errors:
        # insert_rows_json reports per-row failures rather than raising, and a
        # partial insert is worse than none — say which rows and how many.
        logger.error("BigQuery rejected %s row(s): %s", len(errors), errors[:3])
        raise StoreError(f"BigQuery rejected {len(errors)} of {len(rows)} rows")
    return {
        "save_id": rows[0]["save_id"],
        "saved_at": rows[0]["saved_at"],
        "rows": len(rows),
        "table": settings.table_id,
    }


def list_saves(limit: int = 25) -> list[dict[str, Any]]:
    query = f"""
        SELECT save_id, label, projection_season,
               MIN(saved_at) AS saved_at,
               COUNT(*) AS players,
               COUNT(DISTINCT team) AS teams
        FROM `{settings.table_id}`
        GROUP BY save_id, label, projection_season
        ORDER BY saved_at DESC
        LIMIT @limit
    """
    return _run(query, limit=limit)


def load(save_id: str | None = None) -> list[dict[str, Any]]:
    """Every row of one save, defaulting to the most recent."""
    if save_id:
        query = f"SELECT * FROM `{settings.table_id}` WHERE save_id = @save_id"
        return _run(query, save_id=save_id)
    query = f"""
        SELECT * FROM `{settings.table_id}`
        WHERE save_id = (
            SELECT save_id FROM `{settings.table_id}`
            ORDER BY saved_at DESC LIMIT 1
        )
    """
    return _run(query)


def _run(query: str, **parameters: Any) -> list[dict[str, Any]]:
    from google.cloud import bigquery

    types = {int: "INT64", str: "STRING", float: "FLOAT64"}
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter(name, types[type(value)], value)
            for name, value in parameters.items()
        ]
    )
    job = client().query(query, job_config=job_config)
    return [dict(row) for row in job.result()]
