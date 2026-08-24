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

/** Which team-level volume each share divides up. */
export const VOLUME_BY_SHARE = {
  pass: "pass_attempts",
  rush: "carries",
  recv: "targets",
};

/** Kickers score from field goals, not from volume, so the model skips them. */
export const PROJECTED_POSITIONS = new Set(["QB", "RB", "WR", "TE", "FB"]);

const RATE_NAMES = [
  "completion_rate",
  "yards_per_attempt",
  "pass_td_rate",
  "interception_rate",
  "yards_per_carry",
  "rush_td_rate",
  "catch_rate",
  "yards_per_target",
  "rec_td_rate",
  "fumble_rate",
];

/**
 * Resolve the rates a player should be projected on.
 *
 * Three sources, in order: an override you typed, the rate the player earned
 * last season on real volume, and the league median at his position. A rookie
 * lands entirely on the third, which is the honest answer — nothing about him
 * is known yet, so he gets treated as an average player at his position until
 * you say otherwise.
 */
export function effectiveRates(player, leagueRates = {}, overrides = {}) {
  const own = player?.rates || {};
  const league = leagueRates[player?.position] || {};
  const resolved = {};
  for (const name of RATE_NAMES) {
    if (Number.isFinite(overrides[name])) {
      resolved[name] = overrides[name];
    } else if (Number.isFinite(own[name])) {
      resolved[name] = own[name];
    } else {
      resolved[name] = league[name] ?? 0;
    }
  }
  return resolved;
}

/** Where a rate came from, so the interface can show which numbers are guesses. */
export function rateSources(player, leagueRates = {}, overrides = {}) {
  const own = player?.rates || {};
  const sources = {};
  for (const name of RATE_NAMES) {
    if (Number.isFinite(overrides[name])) sources[name] = "override";
    else if (Number.isFinite(own[name])) sources[name] = "player";
    else sources[name] = "league";
  }
  return sources;
}

/**
 * A player's share of each volume last season, on this team.
 *
 * Uses the on-this-team split rather than his season line: a receiver who
 * arrived at the deadline earned his targets here over six games, and counting
 * the ones he earned somewhere else would inflate his claim on this offense.
 * A player who was not here gets zero — he has no history to default to, which
 * is exactly the point at which you have to make a call.
 */
export function defaultShares(player, teamTotals = {}) {
  const here = player?.here_2025;
  if (!here) return { pass: 0, rush: 0, recv: 0 };
  const share = (stat) => {
    const total = teamTotals[stat] || 0;
    return total > 0 ? (here[stat] || 0) / total : 0;
  };
  return {
    pass: share("pass_attempts"),
    rush: share("carries"),
    recv: share("targets"),
  };
}

/**
 * A missing rate means no production, not an unknown quantity.
 *
 * Rates normally arrive complete from `effectiveRates`, but a partial object —
 * a positional rate table that has no passing entries, say — would otherwise
 * multiply into NaN and carry it through every total downstream. A blank cell
 * in a projection table is a bug you notice; a NaN that quietly zeroes a team's
 * points is one you do not.
 */
function rate(rates, name) {
  const value = rates?.[name];
  return Number.isFinite(value) ? value : 0;
}

/** Turn assigned volume into a stat line at the given rates. */
export function projectStats({ volume, shares, rates }) {
  const attempts = (volume.pass_attempts || 0) * (shares.pass || 0);
  const carries = (volume.carries || 0) * (shares.rush || 0);
  const targets = (volume.targets || 0) * (shares.recv || 0);

  const receptions = targets * rate(rates, "catch_rate");
  // Fumbles follow touches, so they are computed after receptions rather than
  // from targets — a drop is not a fumble.
  const touches = carries + receptions;

  return {
    pass_attempts: attempts,
    completions: attempts * rate(rates, "completion_rate"),
    passing_yards: attempts * rate(rates, "yards_per_attempt"),
    passing_tds: attempts * rate(rates, "pass_td_rate"),
    interceptions: attempts * rate(rates, "interception_rate"),
    carries,
    rushing_yards: carries * rate(rates, "yards_per_carry"),
    rushing_tds: carries * rate(rates, "rush_td_rate"),
    targets,
    receptions,
    receiving_yards: targets * rate(rates, "yards_per_target"),
    receiving_tds: targets * rate(rates, "rec_td_rate"),
    fumbles_lost: touches * rate(rates, "fumble_rate"),
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

/**
 * Project one player: stats, points, and per-game rates.
 *
 * `games` is what turns a season total into the number you actually draft on.
 * A back projected for 240 points over 17 games and one projected for 240 over
 * 12 are not the same player, and only the second one has a reason to be on
 * your bench in September.
 */
export function projectPlayer({ player, volume, shares, rates, games = 17 }) {
  const stats = projectStats({ volume, shares, rates });
  const points = fantasyPoints(stats);
  const perGame = games > 0 ? games : 1;
  return {
    player_id: player.player_id,
    player: player.player,
    position: player.position,
    stats,
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
 * Project a whole team, and report how its volume is allocated.
 *
 * The allocation totals are the part worth watching. Shares that sum to less
 * than 100% mean carries nobody has been given; more than 100% means the same
 * carry handed to two backs. Neither is an error the model can resolve on your
 * behalf, so both are reported and left alone.
 */
export function projectTeam({ team, volume, allocations, leagueRates, games = 17 }) {
  const players = [];
  const assigned = { pass: 0, rush: 0, recv: 0 };

  for (const entry of team.roster) {
    if (!PROJECTED_POSITIONS.has(entry.position)) continue;
    const allocation = allocations[entry.player_id];
    if (!allocation) continue;
    const shares = allocation.shares || { pass: 0, rush: 0, recv: 0 };
    for (const key of ["pass", "rush", "recv"]) {
      assigned[key] += shares[key] || 0;
    }
    if (!shares.pass && !shares.rush && !shares.recv) continue;
    players.push(
      projectPlayer({
        player: entry,
        volume,
        shares,
        rates: effectiveRates(entry, leagueRates, allocation.rates || {}),
        games: allocation.games ?? games,
      }),
    );
  }

  players.sort((a, b) => b.points.ppr - a.points.ppr);
  return {
    team: team.team,
    volume,
    players,
    allocated: assigned,
    unallocated: {
      pass: 1 - assigned.pass,
      rush: 1 - assigned.rush,
      recv: 1 - assigned.recv,
    },
  };
}

/**
 * Seed a team's allocations from last season.
 *
 * The starting point is "2026 looks like 2025", which is wrong in a specific and
 * useful way: every share belonging to a player who left is simply missing, so
 * the unallocated total tells you exactly how much of the offense is up for
 * grabs before you have made a single decision.
 */
export function seedAllocations(team) {
  const allocations = {};
  for (const entry of team.roster) {
    if (!PROJECTED_POSITIONS.has(entry.position)) continue;
    allocations[entry.player_id] = {
      shares: defaultShares(entry, team.totals_2025),
      rates: {},
    };
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
