/**
 * Tests for the retry decision on a refused save.
 *
 * The interesting case is the one that looks the same from the outside: two
 * different 401s, one worth re-prompting for and one not. Asking someone to
 * sign in again only to be told no a second time is worse than telling them no
 * once.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isStaleToken } from "../web/js/store.js";

describe("isStaleToken", () => {
  test("an expired token is worth refreshing for", () => {
    assert.equal(isStaleToken(401, "invalid Google token: Token expired"), true);
  });

  test("a missing header is worth refreshing for", () => {
    // The page loaded signed out, or the token was dropped.
    assert.equal(isStaleToken(401, "missing bearer token"), true);
  });

  test("a refused address is not — the answer will not change", () => {
    assert.equal(
      isStaleToken(401, "someone@example.com is not permitted to write to this table"),
      false,
    );
  });

  test("an empty allow list is not — that is a server misconfiguration", () => {
    assert.equal(
      isStaleToken(401, "no ALLOWED_EMAILS configured, so nobody may write"),
      false,
    );
  });

  test("a non-401 is never a token problem", () => {
    assert.equal(isStaleToken(502, "BigQuery rejected 3 of 40 rows"), false);
    assert.equal(isStaleToken(503, "BigQuery saving is turned off"), false);
    assert.equal(isStaleToken(200, ""), false);
  });

  test("a 401 with no detail is treated as final rather than retried forever", () => {
    assert.equal(isStaleToken(401, ""), false);
    assert.equal(isStaleToken(401, undefined), false);
  });
});
