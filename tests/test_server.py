"""Tests for the API surface.

The server's job is small: serve the page, refuse writes it cannot make, and
never return a bare 500 for a condition it could explain. That last one is what
these check — a failed save has to leave the user knowing their work is safe.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from projections import bigquery_store, server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(server.app)


@contextmanager
def configured(**overrides):
    """Swap in a modified Settings for the duration of a test.

    Settings is frozen — deliberately, since a value that can be reassigned at
    runtime is a value you cannot reason about — so a test replaces the whole
    object rather than poking a field on it.
    """
    with patch.object(server, "settings", replace(server.settings, **overrides)):
        yield


SAVE = {
    "projection_season": 2026,
    "teams": [
        {
            "team": "MIN",
            "volume": {"pass_attempts": 550, "carries": 420, "targets": 500},
            "players": [
                {
                    "player_id": "1", "player": "Test", "position": "QB", "games": 17,
                    "shares": {"pass": 1.0}, "stats": {}, "points": {"ppr": 250.0},
                }
            ],
        }
    ],
}


class TestHealth:
    def test_reports_whether_saving_is_available(self, client):
        body = client.get("/api/healthz").json()
        assert body["ok"] is True
        assert "bigquery_enabled" in body


class TestSaving:
    def test_a_successful_save_returns_the_id_and_row_count(self, client):
        fake = {"save_id": "abc", "saved_at": "now", "rows": 1, "table": "p.d.t"}
        with configured(bigquery_enabled=True), patch.object(
            bigquery_store, "save", return_value=fake
        ):
            response = client.post("/api/projections", json=SAVE)
        assert response.status_code == 200
        assert response.json()["rows"] == 1

    def test_a_store_failure_is_explained_not_a_bare_500(self, client):
        with configured(bigquery_enabled=True), patch.object(
            bigquery_store, "save", side_effect=bigquery_store.StoreError("no credentials")
        ):
            response = client.post("/api/projections", json=SAVE)
        assert response.status_code == 502
        assert "no credentials" in response.json()["detail"]

    def test_saving_disabled_says_so(self, client):
        with configured(bigquery_enabled=False):
            response = client.post("/api/projections", json=SAVE)
        assert response.status_code == 503
        assert "BIGQUERY_ENABLED" in response.json()["detail"]


class TestTokenGate:
    def test_no_token_configured_means_writes_are_open(self):
        with configured(api_token=""):
            server.require_token(None)  # local use: must not raise

    def test_a_configured_token_is_required(self):
        with configured(api_token="s3cret"):
            with pytest.raises(server.HTTPException) as caught:
                server.require_token(None)
            assert caught.value.status_code == 401

    def test_the_right_token_passes(self):
        with configured(api_token="s3cret"):
            server.require_token("Bearer s3cret")

    def test_a_wrong_token_is_rejected(self):
        with configured(api_token="s3cret"), pytest.raises(server.HTTPException):
            server.require_token("Bearer guess")

    def test_a_gated_endpoint_rejects_an_unauthenticated_write(self, client):
        with configured(api_token="s3cret", bigquery_enabled=True):
            assert client.post("/api/projections", json=SAVE).status_code == 401


class TestReads:
    def test_listing_saves_is_empty_rather_than_an_error_when_disabled(self, client):
        with configured(bigquery_enabled=False):
            body = client.get("/api/projections/saves").json()
        assert body == {"saves": [], "bigquery_enabled": False}

    def test_the_baseline_is_served(self, client):
        response = client.get("/api/baseline")
        assert response.status_code == 200
        assert "teams" in response.json()
