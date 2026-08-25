"""Who is allowed to write projections.

The page is public — it is a fantasy projection tool, and the NFL data behind it
is public too. What is not public is *your* table. So reading the baseline and
using the workbench need no identity at all, and anything that touches BigQuery
needs to prove it is you.

Two ways to prove it, because two kinds of caller exist:

* A browser signs in with Google and sends the resulting ID token. Google has
  already checked the password and any second factor; this module only checks
  that the token is genuine, was minted for this app, and belongs to an address
  on the allow list.
* A script sends the shared ``API_TOKEN``. No sign-in flow, for curl and cron.

With neither configured — the case when someone runs this on their own machine —
writes are open, because the server is bound to loopback and the only caller is
the person sitting at the keyboard.
"""

from __future__ import annotations

import hmac
import logging

from .config import settings

logger = logging.getLogger(__name__)

# Google mints ID tokens with one of these two issuers. Anything else is not
# Google, whatever the token claims about itself.
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")


class AuthError(Exception):
    """The caller did not prove they are allowed to write."""


def auth_required() -> bool:
    """Whether any credential is demanded at all."""
    return bool(settings.google_client_id or settings.api_token)


def allowed_emails() -> set[str]:
    return {
        email.strip().lower()
        for email in settings.allowed_emails.split(",")
        if email.strip()
    }


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise AuthError("missing bearer token")
    return authorization[len("Bearer ") :].strip()


def _check_api_token(token: str) -> bool:
    if not settings.api_token:
        return False
    # Constant-time: a plain == leaks the shared secret one character at a time
    # to anyone patient enough to measure the difference.
    return hmac.compare_digest(token, settings.api_token)


def _check_google_token(token: str) -> str:
    """Verify a Google ID token and return the address inside it."""
    if not settings.google_client_id:
        raise AuthError("Google sign-in is not configured")
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token as google_id_token
    except ImportError as exc:  # pragma: no cover - import guard
        raise AuthError("google-auth is not installed") from exc

    try:
        # Checks the signature against Google's published keys, the expiry, and
        # that the audience is this app — a valid token minted for some other
        # site is still not a token for this one.
        claims = google_id_token.verify_oauth2_token(
            token, google_requests.Request(), settings.google_client_id
        )
    except ValueError as exc:
        raise AuthError(f"invalid Google token: {exc}") from exc

    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise AuthError("token was not issued by Google")
    if not claims.get("email_verified"):
        raise AuthError("this Google account has no verified email address")

    email = str(claims.get("email") or "").lower()
    permitted = allowed_emails()
    # An empty allow list with sign-in switched on would let any Google account
    # on earth write to the table. Refuse rather than assume.
    if not permitted:
        raise AuthError("no ALLOWED_EMAILS configured, so nobody may write")
    if email not in permitted:
        logger.warning("refused a save from %s", email)
        raise AuthError(f"{email} is not permitted to write to this table")
    return email


def authorize(authorization: str | None) -> str:
    """Return the identity of a caller allowed to write, or raise ``AuthError``.

    Tries the shared token first because it is a cheap string comparison; the
    Google path costs a signature check and, on a cold instance, a fetch of
    Google's signing keys.
    """
    if not auth_required():
        return "local"
    token = _bearer(authorization)
    if _check_api_token(token):
        return "api-token"
    return _check_google_token(token)
