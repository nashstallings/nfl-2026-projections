/**
 * The projection model.
 *
 * One idea runs through all of it: a player's fantasy season is volume times
 * efficiency, and of those two only volume is really yours to assign. A team
 * throws the ball some number of times; that number gets divided among the
 * quarterbacks on the roster; the receiving side of it gets divided among the
 * pass catchers. Efficiency — yards per carry, catch rate, touchdown rate — is
 * the player's own, carried forward from last season unless you overrule it.
 *
 * So every function here takes volume and shares as input and returns a stat
 * line. Nothing reaches for global state, nothing touches the DOM, and the same
 * functions run in the browser and under `node --test`.
 */

/** Standard scoring. PPR and half-PPR are this plus receptions. */
export const SCORING = {
  passingYards: 0.04,
  passingTd: 4,
  interception: -2,
  rushingYards: 0.1,
  rushingTd: 6,
  receivingYards: 0.1,
  receivingTd: 6,
  fumbleLost: -2,
};

/** Kickers score from field goals, not from volume, so the model skips them. */
export const PROJECTED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "FB"]);

/**
 * The numbers you type. Everything else on the row is arithmetic on these.
 *
 * Yards are here because a rate cannot be a read-out without them: yards per
 * target is receiving yards over targets, and if the yards were themselves
 * derived from a rate the arrow would point the other way and the rate would be
 * the input again.
 */
export const COUNT_FIELDS = [
  "pass_attempts", "passing_yards", "passing_tds", "interceptions",
  "carries", "rushing_yards", "rushing_tds",
  "targets", "receptions", "receiving_yards", "receiving_tds",
  "fumbles_lost",
];

/** Which team volume each count is allocated out of, for the totals row. */
export const VOLUME_OF = {
  pass_attempts: "pass_attempts",
  carries: "carries",
  targets: "targets",
};

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** A complete stat line from whatever subset of counts is present. */
export function statsFromCounts(counts = {}) {
  const stats = {};
  for (const field of COUNT_FIELDS) stats[field] = Math.max(0, number(counts[field]));
  return stats;
}

/**
 * A player's 2025 line on this team, as the starting point for editing.
 *
 * Last season's actual numbers rather than a share of anything — the gap
 * between what the returning players did and the 2026 team volume is the
 * vacated volume, sitting there waiting to be handed out.
 *
 * A player who was not here starts empty. That is not missing data; it is the
 * decision the tool exists to make.
 */
export function seedCounts(player) {
  const here = player?.here_2025;
  if (!here) return statsFromCounts({});
  return statsFromCounts(here);
}

/**
 * The rates behind a line. Read-outs, not inputs.
 *
 * A rate with no volume under it is absent rather than zero — a back with no
 * targets has no catch rate, and printing 0% would read as a bad one.
 */
export function derivedRates(stats) {
  const per = (numerator, denominator) =>
    denominator > 0 ? numerator / denominator : null;
  const touches = stats.carries + stats.receptions;
  return {
    yards_per_attempt: per(stats.passing_yards, stats.pass_attempts),
    pass_td_rate: per(stats.passing_tds, stats.pass_attempts),
    interception_rate: per(stats.interceptions, stats.pass_attempts),
    yards_per_carry: per(stats.rushing_yards, stats.carries),
    rush_td_rate: per(stats.rushing_tds, stats.carries),
    catch_rate: per(stats.receptions, stats.targets),
    yards_per_target: per(stats.receiving_yards, stats.targets),
    yards_per_reception: per(stats.receiving_yards, stats.receptions),
    rec_td_rate: per(stats.receiving_tds, stats.targets),
    fumble_rate: per(stats.fumbles_lost, touches),
  };
}

/** Score a stat line in all three formats. */
export function fantasyPoints(stats) {
  const standard =
    stats.passing_yards * SCORING.passingYards +
    stats.passing_tds * SCORING.passingTd +
    stats.interceptions * SCORING.interception +
    stats.rushing_yards * SCORING.rushingYards +
    stats.rushing_tds * SCORING.rushingTd +
    stats.receiving_yards * SCORING.receivingYards +
    stats.receiving_tds * SCORING.receivingTd +
    stats.fumbles_lost * SCORING.fumbleLost;
  return {
    std: standard,
    half_ppr: standard + stats.receptions * 0.5,
    ppr: standard + stats.receptions,
  };
}

/** Project one player from the counts on his row. */
export function projectPlayer({ player, counts, games = 17 }) {
  const stats = statsFromCounts(counts);
  const points = fantasyPoints(stats);
  const perGame = games > 0 ? games : 1;
  return {
    player_id: player.player_id,
    player: player.player,
    position: player.position,
    stats,
    rates: derivedRates(stats),
    points,
    per_game: {
      std: points.std / perGame,
      half_ppr: points.half_ppr / perGame,
      ppr: points.ppr / perGame,
    },
    games,
  };
}

/**
 * Project a whole team, and report the counts against the volume they came out of.
 *
 * ``assigned`` is what the rows add up to; ``unassigned`` is what the team
 * volume has left over. A negative one means you have handed out more attempts
 * than the offence is going to throw — not an error the model can settle, so it
 * is reported rather than clamped.
 */
export function projectTeam({ team, volume, allocations, games = 17 }) {
  const players = [];
  const assigned = { pass_attempts: 0, carries: 0, targets: 0 };
  const totals = Object.fromEntries(COUNT_FIELDS.map((field) => [field, 0]));

  for (const entry of team.roster) {
    if (!PROJECTED_POSITIONS.has(entry.position)) continue;
    const allocation = allocations[entry.player_id];
    if (!allocation) continue;
    const projected = projectPlayer({
      player: entry,
      counts: allocation.counts || {},
      games: allocation.games ?? games,
    });
    for (const field of COUNT_FIELDS) totals[field] += projected.stats[field];
    for (const field of Object.keys(assigned)) assigned[field] += projected.stats[field];
    // A row of nothing is a player you have not projected, not a projection of zero.
    if (Object.values(projected.stats).some((value) => value > 0)) players.push(projected);
  }

  players.sort((a, b) => b.points.ppr - a.points.ppr);
  return {
    team: team.team,
    volume,
    players,
    totals,
    assigned,
    unassigned: {
      pass_attempts: (volume.pass_attempts || 0) - assigned.pass_attempts,
      carries: (volume.carries || 0) - assigned.carries,
      targets: (volume.targets || 0) - assigned.targets,
    },
  };
}

/** Seed every projectable player from what he did here last season. */
export function seedAllocations(team) {
  const allocations = {};
  for (const entry of team.roster) {
    if (!PROJECTED_POSITIONS.has(entry.position)) continue;
    allocations[entry.player_id] = { counts: seedCounts(entry) };
  }
  return allocations;
}

/** Last season's volume, as the default for this one. */
export function seedVolume(team) {
  const totals = team.totals_2025 || {};
  return {
    pass_attempts: Math.round(totals.pass_attempts || 0),
    carries: Math.round(totals.carries || 0),
    targets: Math.round(totals.targets || 0),
  };
}

/**
 * Rank every projected player against their own position.
 *
 * Takes projections from more than one team, because a rank is only meaningful
 * against the rest of the league — QB8 on your board is a decision, 285 points
 * on its own is not.
 */
export function positionalRanks(projections, format = "ppr") {
  const all = projections.flatMap((projection) => projection.players);
  const byPosition = new Map();
  for (const player of all) {
    if (!byPosition.has(player.position)) byPosition.set(player.position, []);
    byPosition.get(player.position).push(player);
  }
  const ranks = new Map();
  for (const group of byPosition.values()) {
    group.sort((a, b) => b.points[format] - a.points[format]);
    group.forEach((player, index) => ranks.set(player.player_id, index + 1));
  }
  return ranks;
}

/**
 * What the rest of the league did with this volume last season.
 *
 * A team's own number means nothing on its own — 484 pass attempts is either a
 * lot or a little depending on the year and the league. The distribution is what
 * turns it into a judgement, and it is already in the baseline: every team's
 * 2025 totals are there, so nothing needs fetching to work it out.
 *
 * Median rather than mean, because one extreme offense should not drag the
 * middle of the league somewhere no team actually sits.
 */
export function leagueRange(teams, stat) {
  const values = Object.values(teams || {})
    .map((team) => Number(team?.totals_2025?.[stat]) || 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);

  if (!values.length) return { min: 0, median: 0, max: 0, count: 0 };

  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;

  return { min: values[0], median, max: values[values.length - 1], count: values.length };
}

/**
 * Where a number would have placed last season. 1 is the most in the league.
 *
 * Ranks the value you are *considering*, not the value the team recorded, so
 * typing 560 targets answers "that would have been third in the league" while
 * you are still deciding.
 */
export function rankInLeague(teams, stat, value) {
  const values = Object.values(teams || {})
    .map((team) => Number(team?.totals_2025?.[stat]) || 0)
    .filter((entry) => entry > 0);
  if (!values.length) return null;
  const ahead = values.filter((entry) => entry > value).length;
  // Capped at the size of the field: a number below every team in the league is
  // last, not one place past last. "33rd of 32" reads as a bug.
  return { rank: Math.min(ahead + 1, values.length), of: values.length };
}

/**
 * A value's position along the league range, as 0-1.
 *
 * Clamped, because a projection is allowed to sit outside anything that happened
 * last season — the marker pins to the end of the scale and the number beside it
 * still tells the truth.
 */
export function positionInRange(value, { min, max }) {
  if (!(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Which rates a player's projection actually depends on, given his shares.
 *
 * A receiver has no passing rates and never will, but he is also never assigned
 * a pass attempt, so the gap does not touch his projection. Judging "is this a
 * guess" against every rate flags every non-quarterback and says nothing; the
 * question is only ever about the rates the volume actually reaches.
 */
/**
 * What a player scored last season in the format currently being read.
 *
 * The baseline stores standard and PPR; half is the midpoint, since the only
 * difference between the two is a point per reception.
 */
export function baselinePoints(entry, format = "ppr") {
  const baseline = entry?.baseline;
  if (!baseline) return null;
  if (format === "std") return baseline.fantasy_points_std;
  if (format === "ppr") return baseline.fantasy_points_ppr;
  return (baseline.fantasy_points_std + baseline.fantasy_points_ppr) / 2;
}
