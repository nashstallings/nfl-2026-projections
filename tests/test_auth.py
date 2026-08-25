"""Tests for who may write.

This is the only part of the app where being wrong has consequences beyond a
bad projection, so the cases below are the ways it could be wrong: an empty
allow list treated as "everyone", a token from a different app accepted because
it is validly signed, an unverified address, a timing-leaky comparison.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from projections import auth  # noqa: E402


@contextmanager
def configured(**overrides):
    with patch.object(auth, "settings", replace(auth.settings, **overrides)):
        yield


def google_claims(**overrides):
    claims = {
        "iss": "https://accounts.google.com",
        "email": "nashstallings17@gmail.com",
        "email_verified": True,
    }
    claims.update(overrides)
    return claims


@contextmanager
def google_returns(claims):
    with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
        yield


@contextmanager
def google_rejects(message="Token expired"):
    with patch(
        "google.oauth2.id_token.verify_oauth2_token", side_effect=ValueError(message)
    ):
        yield


class TestUnconfigured:
    def test_with_nothing_configured_writes_are_open(self):
        """The local case: bound to loopback, one person at the keyboard."""
        with configured(google_client_id="", api_token="", allowed_emails=""):
            assert auth.auth_required() is False
            assert auth.authorize(None) == "local"

    def test_configuring_either_mechanism_closes_it(self):
        with configured(api_token="s3cret"):
            assert auth.auth_required() is True
        with configured(google_client_id="app.apps.googleusercontent.com"):
            assert auth.auth_required() is True


class TestApiToken:
    def test_the_right_token_is_accepted(self):
        with configured(api_token="s3cret"):
            assert auth.authorize("Bearer s3cret") == "api-token"

    def test_a_wrong_token_is_refused(self):
        with configured(api_token="s3cret"):
            with pytest.raises(auth.AuthError):
                auth.authorize("Bearer guess")

    def test_a_missing_header_is_refused(self):
        with configured(api_token="s3cret"):
            with pytest.raises(auth.AuthError, match="missing bearer token"):
                auth.authorize(None)

    def test_a_malformed_header_is_refused(self):
        with configured(api_token="s3cret"):
            with pytest.raises(auth.AuthError, match="missing bearer token"):
                auth.authorize("s3cret")  # no "Bearer " prefix


class TestGoogleSignIn:
    CLIENT = "app.apps.googleusercontent.com"

    def test_an_allowed_address_may_write(self):
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ), google_returns(google_claims()):
            assert auth.authorize("Bearer tok") == "nashstallings17@gmail.com"

    def test_the_allow_list_is_case_insensitive(self):
        with configured(
            google_client_id=self.CLIENT, allowed_emails="NashStallings17@Gmail.com"
        ), google_returns(google_claims(email="nashstallings17@gmail.com")):
            assert auth.authorize("Bearer tok") == "nashstallings17@gmail.com"

    def test_another_google_account_may_not_write(self):
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ), google_returns(google_claims(email="someone.else@gmail.com")):
            with pytest.raises(auth.AuthError, match="not permitted"):
                auth.authorize("Bearer tok")

    def test_an_empty_allow_list_permits_nobody(self):
        """Sign-in on with no allow list must not mean 'any Google account'."""
        with configured(
            google_client_id=self.CLIENT, allowed_emails=""
        ), google_returns(google_claims()):
            with pytest.raises(auth.AuthError, match="nobody may write"):
                auth.authorize("Bearer tok")

    def test_an_unverified_address_is_refused(self):
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ), google_returns(google_claims(email_verified=False)):
            with pytest.raises(auth.AuthError, match="verified"):
                auth.authorize("Bearer tok")

    def test_a_token_google_rejects_is_refused(self):
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ), google_rejects("Token expired"):
            with pytest.raises(auth.AuthError, match="invalid Google token"):
                auth.authorize("Bearer tok")

    def test_a_token_from_another_issuer_is_refused(self):
        """Verification is mocked here, so the issuer check has to stand alone."""
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ), google_returns(google_claims(iss="https://evil.example.com")):
            with pytest.raises(auth.AuthError, match="not issued by Google"):
                auth.authorize("Bearer tok")

    def test_the_client_id_is_passed_to_google_as_the_audience(self):
        """A validly signed token minted for another site is not a token for this one."""
        with configured(
            google_client_id=self.CLIENT, allowed_emails="nashstallings17@gmail.com"
        ):
            with patch(
                "google.oauth2.id_token.verify_oauth2_token",
                return_value=google_claims(),
            ) as verify:
                auth.authorize("Bearer tok")
            assert verify.call_args.args[2] == self.CLIENT

    def test_with_only_google_configured_an_api_token_does_not_work(self):
        with configured(
            google_client_id=self.CLIENT,
            api_token="",
            allowed_emails="nashstallings17@gmail.com",
        ), google_rejects("Wrong number of segments"):
            with pytest.raises(auth.AuthError):
                auth.authorize("Bearer some-random-string")


class TestAllowList:
    def test_addresses_are_split_trimmed_and_lowercased(self):
        with configured(allowed_emails=" A@b.com , C@d.com ,"):
            assert auth.allowed_emails() == {"a@b.com", "c@d.com"}

    def test_an_unset_list_is_empty_not_none(self):
        with configured(allowed_emails=""):
            assert auth.allowed_emails() == set()
