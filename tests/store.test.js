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

import { isStaleToken, stateFromRows } from "../web/js/store.js";

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

describe("stateFromRows", () => {
  const row = {
    team: "MIN", player_id: "1", games: 17,
    team_pass_attempts: 550, team_carries: 420, team_targets: 500,
    carries: 260, rushing_yards: 1150, rushing_tds: 9,
    targets: 60, receptions: 48, receiving_yards: 400, receiving_tds: 2,
  };

  test("a save restores the team volume and the line you typed", () => {
    const state = stateFromRows([row]);
    assert.deepEqual(state.teams.MIN.volume, {
      pass_attempts: 550, carries: 420, targets: 500,
    });
    const counts = state.teams.MIN.allocations["1"].counts;
    assert.equal(counts.carries, 260);
    assert.equal(counts.receiving_yards, 400);
  });

  test("games are restored when they were not the default", () => {
    const state = stateFromRows([{ ...row, games: 13 }]);
    assert.equal(state.teams.MIN.allocations["1"].games, 13);
  });

  test("several teams in one save come back separately", () => {
    const state = stateFromRows([row, { ...row, team: "PHI", player_id: "2" }]);
    assert.deepEqual(Object.keys(state.teams).sort(), ["MIN", "PHI"]);
  });

  test("a malformed row is skipped, not fatal to the rest of the save", () => {
    const state = stateFromRows([{ team: "MIN" }, row, null, { player_id: "x" }]);
    assert.equal(Object.keys(state.teams.MIN.allocations).length, 1);
  });

  test("an empty save produces empty state rather than throwing", () => {
    assert.deepEqual(stateFromRows([]), { teams: {} });
    assert.deepEqual(stateFromRows(null), { teams: {} });
  });

  test("missing counts become zero rather than NaN", () => {
    const state = stateFromRows([{ team: "MIN", player_id: "1" }]);
    assert.equal(state.teams.MIN.volume.carries, 0);
    assert.equal(state.teams.MIN.allocations["1"].counts.carries, 0);
  });
});
