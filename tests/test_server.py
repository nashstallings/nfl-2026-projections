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

from projections import auth, bigquery_store, server  # noqa: E402


@pytest.fixture
def client():
    return TestClient(server.app)


@contextmanager
def configured(**overrides):
    """Swap in a modified Settings for the duration of a test.

    Settings is frozen — deliberately, since a value that can be reassigned at
    runtime is a value you cannot reason about — so a test replaces the whole
    object rather than poking a field on it. Both modules that read settings get
    the same replacement, since a request crosses both.
    """
    swapped = replace(server.settings, **overrides)
    with patch.object(server, "settings", swapped), patch.object(
        auth, "settings", swapped
    ):
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


class TestAuthorization:
    """The HTTP surface of the gate. Which credentials count is test_auth.py."""

    def test_writes_are_open_when_nothing_is_configured(self, client):
        fake = {"save_id": "a", "saved_at": "now", "rows": 1, "table": "t"}
        with configured(
            api_token="", google_client_id="", bigquery_enabled=True
        ), patch.object(bigquery_store, "save", return_value=fake):
            assert client.post("/api/projections", json=SAVE).status_code == 200

    def test_an_unauthenticated_write_is_refused(self, client):
        with configured(api_token="s3cret", bigquery_enabled=True):
            response = client.post("/api/projections", json=SAVE)
        assert response.status_code == 401
        assert "bearer" in response.json()["detail"].lower()

    def test_a_valid_token_gets_through(self, client):
        fake = {"save_id": "a", "saved_at": "now", "rows": 1, "table": "t"}
        with configured(api_token="s3cret", bigquery_enabled=True), patch.object(
            bigquery_store, "save", return_value=fake
        ):
            response = client.post(
                "/api/projections",
                json=SAVE,
                headers={"Authorization": "Bearer s3cret"},
            )
        assert response.status_code == 200

    def test_the_refusal_says_why(self, client):
        """A 401 with no reason is a support request; this one is actionable."""
        with configured(
            google_client_id="app.apps.googleusercontent.com",
            api_token="",
            allowed_emails="",
            bigquery_enabled=True,
        ), patch(
            "google.oauth2.id_token.verify_oauth2_token",
            side_effect=ValueError("Token expired"),
        ):
            response = client.post(
                "/api/projections", json=SAVE, headers={"Authorization": "Bearer old"}
            )
        assert response.status_code == 401
        assert "invalid Google token" in response.json()["detail"]

    def test_reading_saved_projections_is_gated_too(self, client):
        """Saved projections are the user's data, not public NFL data."""
        with configured(api_token="s3cret", bigquery_enabled=True):
            assert client.get("/api/projections/saves").status_code == 401
            assert client.get("/api/projections/latest").status_code == 401


class TestClientConfig:
    def test_the_page_is_told_the_client_id_and_whether_to_sign_in(self, client):
        with configured(
            google_client_id="app.apps.googleusercontent.com",
            allowed_emails="me@example.com",
        ):
            body = client.get("/api/config").json()
        assert body["google_client_id"] == "app.apps.googleusercontent.com"
        assert body["auth_required"] is True

    def test_the_allow_list_is_never_served_to_the_page(self, client):
        with configured(
            google_client_id="app.apps.googleusercontent.com",
            allowed_emails="me@example.com",
        ):
            body = client.get("/api/config").json()
        assert "allowed_emails" not in body
        assert "me@example.com" not in str(body)

    def test_locally_the_page_is_told_no_sign_in_is_needed(self, client):
        with configured(google_client_id="", api_token=""):
            assert client.get("/api/config").json()["auth_required"] is False


class TestReads:
    def test_listing_saves_is_empty_rather_than_an_error_when_disabled(self, client):
        with configured(bigquery_enabled=False, api_token="", google_client_id=""):
            body = client.get("/api/projections/saves").json()
        assert body == {"saves": [], "bigquery_enabled": False}

    def test_the_baseline_is_served(self, client):
        response = client.get("/api/baseline")
        assert response.status_code == 200
        assert "teams" in response.json()
