/**
 * Tests for the projection model.
 *
 * The arithmetic is simple enough to look obviously right and still be wrong in
 * ways that only surface as a bad row: a rate printed as zero where there is no
 * volume to divide by, fumbles counted off targets rather than touches, a
 * cleared box read as a decision instead of a keystroke. Each is a case below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COUNT_FIELDS,
  baselinePoints,
  derivedRates,
  fantasyPoints,
  leagueRange,
  positionInRange,
  positionalRanks,
  projectPlayer,
  projectTeam,
  rankInLeague,
  seedAllocations,
  seedCounts,
  seedVolume,
  statsFromCounts,
} from "../web/js/projection.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

describe("statsFromCounts", () => {
  test("every field is present even when only some were typed", () => {
    const stats = statsFromCounts({ carries: 200 });
    assert.deepEqual(Object.keys(stats).sort(), [...COUNT_FIELDS].sort());
    assert.equal(stats.targets, 0);
  });

  test("negatives are floored at zero — nobody runs for minus 40 carries", () => {
    assert.equal(statsFromCounts({ carries: -40 }).carries, 0);
  });

  test("unparseable values become zero rather than NaN", () => {
    assert.equal(statsFromCounts({ carries: "lots" }).carries, 0);
  });
});

describe("seedCounts", () => {
  test("a returning player starts from what he did here", () => {
    const player = { here_2025: { carries: 200, rushing_yards: 900, targets: 48 } };
    const seeded = seedCounts(player);
    assert.equal(seeded.carries, 200);
    assert.equal(seeded.rushing_yards, 900);
  });

  test("a newcomer starts empty — that is the decision, not missing data", () => {
    assert.equal(seedCounts({ here_2025: null }).carries, 0);
    assert.equal(seedCounts(undefined).targets, 0);
  });
});

describe("derivedRates", () => {
  test("rates are read off the counts", () => {
    const stats = statsFromCounts({
      carries: 200, rushing_yards: 900, targets: 50, receptions: 40,
      receiving_yards: 400, receiving_tds: 4,
    });
    const rates = derivedRates(stats);
    close(rates.yards_per_carry, 4.5);
    close(rates.catch_rate, 0.8);
    close(rates.yards_per_target, 8);
    close(rates.yards_per_reception, 10);
    close(rates.rec_td_rate, 0.08);
  });

  test("a rate with no volume under it is absent, not zero", () => {
    // A back with no targets has no catch rate; 0% would read as a bad one.
    const rates = derivedRates(statsFromCounts({ carries: 200 }));
    assert.equal(rates.catch_rate, null);
    assert.equal(rates.yards_per_target, null);
  });

  test("fumble rate is per touch, so a catch counts and a target does not", () => {
    const stats = statsFromCounts({
      carries: 100, targets: 40, receptions: 20, fumbles_lost: 3,
    });
    close(derivedRates(stats).fumble_rate, 3 / 120);
  });
});

describe("fantasyPoints", () => {
  test("a receiving line scores the reception bonus in each format", () => {
    const stats = statsFromCounts({
      receiving_yards: 1000, receiving_tds: 8, receptions: 80,
    });
    const points = fantasyPoints(stats);
    close(points.std, 100 + 48);
    close(points.half_ppr, 148 + 40);
    close(points.ppr, 148 + 80);
  });

  test("turnovers subtract", () => {
    const base = statsFromCounts({ rushing_yards: 100 });
    close(fantasyPoints(base).std, 10);
    close(fantasyPoints(statsFromCounts({ rushing_yards: 100, fumbles_lost: 2 })).std, 6);
  });

  test("a passing line scores the same in all three formats", () => {
    const stats = statsFromCounts({
      passing_yards: 4000, passing_tds: 30, interceptions: 10,
    });
    const points = fantasyPoints(stats);
    close(points.std, 160 + 120 - 20);
    assert.equal(points.std, points.ppr);
  });
});

describe("projectPlayer", () => {
  test("points come straight off the counts", () => {
    const result = projectPlayer({
      player: { player_id: "1", player: "Back", position: "RB" },
      counts: { carries: 250, rushing_yards: 1100, rushing_tds: 9 },
    });
    close(result.points.std, 110 + 54);
    close(result.rates.yards_per_carry, 4.4);
  });

  test("per-game divides by the games projected", () => {
    const result = projectPlayer({
      player: { player_id: "1", player: "Back", position: "RB" },
      counts: { rushing_yards: 1200 },
      games: 12,
    });
    close(result.per_game.std, 10);
  });
});

describe("projectTeam", () => {
  const team = {
    team: "MIN",
    totals_2025: { pass_attempts: 500, carries: 400, targets: 480 },
    roster: [
      { player_id: "qb", player: "QB", position: "QB", here_2025: { pass_attempts: 480 } },
      { player_id: "rb", player: "RB", position: "RB", here_2025: { carries: 200 } },
    ],
  };
  const volume = { pass_attempts: 550, carries: 420, targets: 500 };

  test("what is left of the team volume is reported, not clamped", () => {
    const result = projectTeam({
      team, volume,
      allocations: {
        qb: { counts: { pass_attempts: 500 } },
        rb: { counts: { carries: 300 } },
      },
    });
    close(result.unassigned.pass_attempts, 50);
    close(result.unassigned.carries, 120);
    close(result.unassigned.targets, 500);
  });

  test("over-allocation reads as negative rather than being corrected", () => {
    const result = projectTeam({
      team, volume, allocations: { qb: { counts: { pass_attempts: 600 } } },
    });
    close(result.unassigned.pass_attempts, -50);
  });

  test("an empty row is a player not projected, not a projection of zero", () => {
    const result = projectTeam({
      team, volume, allocations: { qb: { counts: {} }, rb: { counts: { carries: 1 } } },
    });
    assert.deepEqual(result.players.map((p) => p.player_id), ["rb"]);
  });

  test("totals cover every count, not only the allocated three", () => {
    const result = projectTeam({
      team, volume,
      allocations: { qb: { counts: { pass_attempts: 500, passing_tds: 28 } } },
    });
    close(result.totals.passing_tds, 28);
  });

  test("players come back ranked by projected PPR points", () => {
    const result = projectTeam({
      team, volume,
      allocations: {
        qb: { counts: { passing_yards: 4000, passing_tds: 30 } },
        rb: { counts: { rushing_yards: 800 } },
      },
    });
    const points = result.players.map((p) => p.points.ppr);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  });
});

describe("seeding", () => {
  const team = {
    team: "MIN",
    totals_2025: { pass_attempts: 500, carries: 400, targets: 480 },
    roster: [
      { player_id: "stay", position: "RB", here_2025: { carries: 200, targets: 48 } },
      { player_id: "new", position: "WR", here_2025: null },
    ],
  };

  test("volume defaults to last season's", () => {
    assert.deepEqual(seedVolume(team), {
      pass_attempts: 500, carries: 400, targets: 480,
    });
  });

  test("returning players seed from their own line, newcomers from nothing", () => {
    const seeded = seedAllocations(team);
    assert.equal(seeded.stay.counts.carries, 200);
    assert.equal(seeded.new.counts.carries, 0);
  });

  test("the gap the departed left shows up as unassigned volume", () => {
    // 400 carries in the offence, 200 belonging to someone still here.
    const result = projectTeam({
      team,
      volume: seedVolume(team),
      allocations: seedAllocations(team),
    });
    close(result.unassigned.carries, 200);
  });
});

describe("positionalRanks", () => {
  test("players are ranked against their own position across teams", () => {
    const projections = [
      { players: [
        { player_id: "a", position: "RB", points: { ppr: 300 } },
        { player_id: "b", position: "WR", points: { ppr: 280 } },
      ] },
      { players: [
        { player_id: "c", position: "RB", points: { ppr: 310 } },
        { player_id: "d", position: "WR", points: { ppr: 250 } },
      ] },
    ];
    const ranks = positionalRanks(projections);
    assert.equal(ranks.get("c"), 1);
    assert.equal(ranks.get("a"), 2);
    assert.equal(ranks.get("b"), 1);
    assert.equal(ranks.get("d"), 2);
  });

  test("ranking honours the scoring format asked for", () => {
    const projections = [
      { players: [
        { player_id: "catcher", position: "RB", points: { std: 200, ppr: 300 } },
        { player_id: "runner", position: "RB", points: { std: 240, ppr: 260 } },
      ] },
    ];
    assert.equal(positionalRanks(projections, "std").get("runner"), 1);
    assert.equal(positionalRanks(projections, "ppr").get("catcher"), 1);
  });
});

describe("league context", () => {
  const teams = {
    A: { totals_2025: { carries: 300 } },
    B: { totals_2025: { carries: 400 } },
    C: { totals_2025: { carries: 500 } },
    D: { totals_2025: { carries: 600 } },
  };

  test("the range spans the league", () => {
    const range = leagueRange(teams, "carries");
    assert.equal(range.min, 300);
    assert.equal(range.max, 600);
    assert.equal(range.count, 4);
  });

  test("an even league median is the midpoint of the middle two", () => {
    assert.equal(leagueRange(teams, "carries").median, 450);
  });

  test("an odd league median is the middle value", () => {
    const odd = { A: teams.A, B: teams.B, C: teams.C };
    assert.equal(leagueRange(odd, "carries").median, 400);
  });

  test("teams with no volume in a category are left out", () => {
    const withZero = { ...teams, E: { totals_2025: { carries: 0 } } };
    assert.equal(leagueRange(withZero, "carries").count, 4);
  });

  test("an unknown stat degrades to zeroes rather than NaN", () => {
    const range = leagueRange(teams, "field_goals");
    assert.deepEqual(range, { min: 0, median: 0, max: 0, count: 0 });
  });

  test("the highest value ranks first", () => {
    assert.deepEqual(rankInLeague(teams, "carries", 600), { rank: 1, of: 4 });
  });

  test("ranking is of the value being considered, not one already recorded", () => {
    // 550 is nobody's actual total; it would still have placed second.
    assert.deepEqual(rankInLeague(teams, "carries", 550), { rank: 2, of: 4 });
  });

  test("a value past the league best still ranks first", () => {
    assert.equal(rankInLeague(teams, "carries", 9999).rank, 1);
  });

  test("a value below every team ranks last, not past last", () => {
    // Uncapped this reads "5th of 4", which looks like a bug rather than a floor.
    assert.deepEqual(rankInLeague(teams, "carries", 1), { rank: 4, of: 4 });
  });

  test("position maps the ends of the range to 0 and 1", () => {
    const range = leagueRange(teams, "carries");
    assert.equal(positionInRange(300, range), 0);
    assert.equal(positionInRange(600, range), 1);
    assert.equal(positionInRange(450, range), 0.5);
  });

  test("position clamps outside the range rather than overflowing the track", () => {
    const range = leagueRange(teams, "carries");
    assert.equal(positionInRange(50, range), 0);
    assert.equal(positionInRange(5000, range), 1);
  });

  test("a degenerate range does not divide by zero", () => {
    assert.equal(positionInRange(5, { min: 10, max: 10 }), 0);
  });
});

describe("baselinePoints", () => {
  const entry = { baseline: { fantasy_points_std: 117.5, fantasy_points_ppr: 201.5 } };

  test("each format reads its own number", () => {
    assert.equal(baselinePoints(entry, "std"), 117.5);
    assert.equal(baselinePoints(entry, "ppr"), 201.5);
  });

  test("half PPR is the midpoint, since the gap is one point per catch", () => {
    assert.equal(baselinePoints(entry, "half_ppr"), 159.5);
  });

  test("a player with no 2025 season has no number rather than a zero", () => {
    assert.equal(baselinePoints({ baseline: null }, "ppr"), null);
    assert.equal(baselinePoints(undefined, "ppr"), null);
  });
});

