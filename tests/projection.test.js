/**
 * Tests for the projection model.
 *
 * The arithmetic here is simple enough to look obviously right and still be
 * wrong in ways that only show up as a quarterback with 900 carries: a share
 * applied to the wrong volume, a rate defaulting to zero instead of the league
 * median, fumbles counted off targets. Each of those is a case below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECTED_POSITIONS,
  defaultShares,
  leagueRange,
  positionInRange,
  rankInLeague,
  effectiveRates,
  fantasyPoints,
  positionalRanks,
  projectPlayer,
  projectStats,
  projectTeam,
  rateSources,
  seedAllocations,
  seedVolume,
} from "../web/js/projection.js";

const LEAGUE_RATES = {
  QB: {
    completion_rate: 0.645,
    yards_per_attempt: 6.94,
    pass_td_rate: 0.045,
    interception_rate: 0.0195,
    yards_per_carry: 5.1,
    rush_td_rate: 0.039,
    fumble_rate: 0.01,
  },
  RB: {
    yards_per_carry: 4.33,
    rush_td_rate: 0.032,
    catch_rate: 0.784,
    yards_per_target: 5.74,
    rec_td_rate: 0.036,
    fumble_rate: 0.005,
  },
  WR: {
    catch_rate: 0.629,
    yards_per_target: 7.63,
    rec_td_rate: 0.048,
    fumble_rate: 0.002,
  },
};

const NO_RATES = {
  completion_rate: 0, yards_per_attempt: 0, pass_td_rate: 0, interception_rate: 0,
  yards_per_carry: 0, rush_td_rate: 0, catch_rate: 0, yards_per_target: 0,
  rec_td_rate: 0, fumble_rate: 0,
};

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

describe("effectiveRates", () => {
  const rookie = { position: "RB", rates: {} };
  const veteran = { position: "RB", rates: { yards_per_carry: 5.2 } };

  test("a player's own rate wins over the league median", () => {
    assert.equal(effectiveRates(veteran, LEAGUE_RATES).yards_per_carry, 5.2);
  });

  test("a rookie falls back to the league median at his position", () => {
    assert.equal(effectiveRates(rookie, LEAGUE_RATES).yards_per_carry, 4.33);
  });

  test("a rate the player did not earn falls back even when others did", () => {
    // He had the carries for a rushing rate but not the targets for a receiving one.
    assert.equal(effectiveRates(veteran, LEAGUE_RATES).catch_rate, 0.784);
  });

  test("an override wins over both", () => {
    const rates = effectiveRates(veteran, LEAGUE_RATES, { yards_per_carry: 6.0 });
    assert.equal(rates.yards_per_carry, 6.0);
  });

  test("an unknown position resolves to zero rather than undefined", () => {
    const rates = effectiveRates({ position: "LS", rates: {} }, LEAGUE_RATES);
    assert.equal(rates.yards_per_carry, 0);
  });

  test("sources are reported so the interface can mark estimates", () => {
    const sources = rateSources(veteran, LEAGUE_RATES, { catch_rate: 0.7 });
    assert.equal(sources.yards_per_carry, "player");
    assert.equal(sources.catch_rate, "override");
    assert.equal(sources.yards_per_target, "league");
  });
});

describe("defaultShares", () => {
  const totals = { pass_attempts: 500, carries: 400, targets: 480 };

  test("a share is measured against this team's volume", () => {
    const player = { here_2025: { pass_attempts: 0, carries: 200, targets: 48 } };
    const shares = defaultShares(player, totals);
    close(shares.rush, 0.5);
    close(shares.recv, 0.1);
    assert.equal(shares.pass, 0);
  });

  test("a player who was not on this team last season starts at zero", () => {
    assert.deepEqual(defaultShares({ here_2025: null }, totals), {
      pass: 0, rush: 0, recv: 0,
    });
  });

  test("only the volume earned here counts, not the full season line", () => {
    // Traded at the deadline: 300 carries on the year, 60 of them here.
    const player = {
      carries: 300,
      here_2025: { pass_attempts: 0, carries: 60, targets: 0 },
    };
    close(defaultShares(player, totals).rush, 0.15);
  });

  test("a team with no volume in a category does not divide by zero", () => {
    const player = { here_2025: { pass_attempts: 10, carries: 0, targets: 0 } };
    assert.equal(defaultShares(player, { pass_attempts: 0 }).pass, 0);
  });
});

describe("projectStats", () => {
  const volume = { pass_attempts: 600, carries: 400, targets: 500 };

  test("each share is applied to its own volume", () => {
    const stats = projectStats({
      volume,
      shares: { pass: 0.9, rush: 0.05, recv: 0.2 },
      rates: NO_RATES,
    });
    close(stats.pass_attempts, 540);
    close(stats.carries, 20);
    close(stats.targets, 100);
  });

  test("counting stats come off their own volume at the given rate", () => {
    const stats = projectStats({
      volume,
      shares: { pass: 0, rush: 0.5, recv: 0.1 },
      rates: { ...NO_RATES, yards_per_carry: 4.5, rush_td_rate: 0.03, catch_rate: 0.7, yards_per_target: 8 },
    });
    close(stats.rushing_yards, 200 * 4.5);
    close(stats.rushing_tds, 200 * 0.03);
    close(stats.receptions, 50 * 0.7);
    close(stats.receiving_yards, 50 * 8);
  });

  test("fumbles follow touches, so a drop is not a fumble", () => {
    // 100 carries and 40 targets caught at 50% is 120 touches, not 140.
    const stats = projectStats({
      volume: { carries: 100, targets: 40 },
      shares: { pass: 0, rush: 1, recv: 1 },
      rates: { ...NO_RATES, catch_rate: 0.5, fumble_rate: 0.01 },
    });
    close(stats.fumbles_lost, 1.2);
  });

  test("zero shares produce an empty line rather than NaN", () => {
    const stats = projectStats({
      volume,
      shares: { pass: 0, rush: 0, recv: 0 },
      rates: LEAGUE_RATES.RB,
    });
    for (const value of Object.values(stats)) assert.ok(Number.isFinite(value));
    close(stats.rushing_yards, 0);
  });
});

describe("fantasyPoints", () => {
  test("a receiving line scores the reception bonus in each format", () => {
    const points = fantasyPoints({
      passing_yards: 0, passing_tds: 0, interceptions: 0,
      rushing_yards: 0, rushing_tds: 0,
      receiving_yards: 1000, receiving_tds: 8, receptions: 80, fumbles_lost: 0,
    });
    close(points.std, 100 + 48);
    close(points.half_ppr, 148 + 40);
    close(points.ppr, 148 + 80);
  });

  test("a passing line scores the same in all three formats", () => {
    const line = {
      passing_yards: 4000, passing_tds: 30, interceptions: 10,
      rushing_yards: 0, rushing_tds: 0, receiving_yards: 0, receiving_tds: 0,
      receptions: 0, fumbles_lost: 0,
    };
    const points = fantasyPoints(line);
    close(points.std, 160 + 120 - 20);
    assert.equal(points.std, points.ppr);
  });

  test("turnovers subtract", () => {
    const base = {
      passing_yards: 0, passing_tds: 0, interceptions: 0, rushing_yards: 100,
      rushing_tds: 0, receiving_yards: 0, receiving_tds: 0, receptions: 0,
      fumbles_lost: 0,
    };
    close(fantasyPoints(base).std, 10);
    close(fantasyPoints({ ...base, fumbles_lost: 2 }).std, 6);
  });
});

describe("projectPlayer", () => {
  test("per-game rates divide by the games projected, not by 17", () => {
    const result = projectPlayer({
      player: { player_id: "1", player: "Injured Back", position: "RB" },
      volume: { carries: 400, targets: 0, pass_attempts: 0 },
      shares: { pass: 0, rush: 0.5, recv: 0 },
      rates: { ...NO_RATES, yards_per_carry: 5 },
      games: 12,
    });
    close(result.points.std, 100);
    close(result.per_game.std, 100 / 12);
  });

  test("a zero-game projection does not divide by zero", () => {
    const result = projectPlayer({
      player: { player_id: "1", player: "Holdout", position: "RB" },
      volume: { carries: 400 },
      shares: { rush: 0.5 },
      rates: { ...NO_RATES, yards_per_carry: 5 },
      games: 0,
    });
    assert.ok(Number.isFinite(result.per_game.std));
  });
});

describe("projectTeam", () => {
  const team = {
    team: "MIN",
    totals_2025: { pass_attempts: 500, carries: 400, targets: 480 },
    roster: [
      { player_id: "qb", player: "Starter QB", position: "QB", rates: { yards_per_attempt: 7.5, pass_td_rate: 0.05, completion_rate: 0.66, interception_rate: 0.02 } },
      { player_id: "rb", player: "Lead Back", position: "RB", rates: { yards_per_carry: 4.6 } },
      { player_id: "k", player: "Kicker", position: "K", rates: {} },
    ],
  };
  const volume = { pass_attempts: 550, carries: 420, targets: 500 };

  test("kickers are excluded — they do not score off offensive volume", () => {
    const result = projectTeam({
      team,
      volume,
      allocations: {
        qb: { shares: { pass: 1, rush: 0, recv: 0 } },
        k: { shares: { pass: 0, rush: 0, recv: 1 } },
      },
      leagueRates: LEAGUE_RATES,
    });
    assert.deepEqual(result.players.map((p) => p.player_id), ["qb"]);
    assert.ok(!PROJECTED_POSITIONS.has("K"));
  });

  test("unallocated volume is reported rather than silently absorbed", () => {
    const result = projectTeam({
      team,
      volume,
      allocations: {
        qb: { shares: { pass: 0.85, rush: 0, recv: 0 } },
        rb: { shares: { pass: 0, rush: 0.6, recv: 0.1 } },
      },
      leagueRates: LEAGUE_RATES,
    });
    close(result.unallocated.pass, 0.15);
    close(result.unallocated.rush, 0.4);
    close(result.unallocated.recv, 0.9);
  });

  test("over-allocation is reported as negative rather than clamped", () => {
    const result = projectTeam({
      team,
      volume,
      allocations: {
        qb: { shares: { pass: 0.7 } },
        rb: { shares: { pass: 0.7 } },
      },
      leagueRates: LEAGUE_RATES,
    });
    close(result.allocated.pass, 1.4);
    close(result.unallocated.pass, -0.4);
  });

  test("players are returned ranked by projected PPR points", () => {
    const result = projectTeam({
      team,
      volume,
      allocations: {
        qb: { shares: { pass: 1 } },
        rb: { shares: { rush: 1, recv: 0.15 } },
      },
      leagueRates: LEAGUE_RATES,
    });
    const points = result.players.map((p) => p.points.ppr);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  });

  test("a player with no allocation is left out entirely", () => {
    const result = projectTeam({
      team, volume, allocations: {}, leagueRates: LEAGUE_RATES,
    });
    assert.equal(result.players.length, 0);
  });

  test("a per-player rate override reaches the projection", () => {
    const base = projectTeam({
      team, volume,
      allocations: { rb: { shares: { rush: 1 } } },
      leagueRates: LEAGUE_RATES,
    });
    const boosted = projectTeam({
      team, volume,
      allocations: { rb: { shares: { rush: 1 }, rates: { yards_per_carry: 9.2 } } },
      leagueRates: LEAGUE_RATES,
    });
    assert.ok(boosted.players[0].points.ppr > base.players[0].points.ppr);
  });
});

describe("seeding", () => {
  const team = {
    team: "MIN",
    totals_2025: { pass_attempts: 500, carries: 400, targets: 480 },
    roster: [
      { player_id: "stay", position: "RB", here_2025: { pass_attempts: 0, carries: 200, targets: 48 } },
      { player_id: "new", position: "WR", here_2025: null },
      { player_id: "k", position: "K", here_2025: null },
    ],
  };

  test("volume defaults to last season's", () => {
    assert.deepEqual(seedVolume(team), {
      pass_attempts: 500, carries: 400, targets: 480,
    });
  });

  test("returning players keep their share and newcomers start empty", () => {
    const seeded = seedAllocations(team);
    close(seeded.stay.shares.rush, 0.5);
    assert.equal(seeded.new.shares.rush, 0);
    assert.ok(!("k" in seeded), "kickers are not allocated volume");
  });

  test("the gap left by departed players shows up as unallocated volume", () => {
    // Only half the carries belong to someone still on the roster, so seeding
    // should leave the other half visibly unassigned.
    const result = projectTeam({
      team,
      volume: seedVolume(team),
      allocations: seedAllocations(team),
      leagueRates: LEAGUE_RATES,
    });
    close(result.unallocated.rush, 0.5);
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
