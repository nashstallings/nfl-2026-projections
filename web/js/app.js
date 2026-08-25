/**
 * The dashboard.
 *
 * State is one object: the 2026 volume and per-player shares for every team you
 * have touched. Everything on screen is derived from it by the pure functions in
 * projection.js, so a keystroke updates state, re-derives, and repaints — there
 * is no second copy of a number to fall out of sync.
 */

import {
  COUNT_FIELDS,
  PROJECTED_POSITIONS,
  baselinePoints,
  derivedRates,
  fantasyPoints,
  leagueRange,
  positionInRange,
  positionalRanks,
  projectTeam,
  rankInLeague,
  seedAllocations,
  seedCounts,
  seedVolume,
  statsFromCounts,
} from "./projection.js";
import { initAuth, onChange as onAuthChange, status as authStatus } from "./auth.js";
import { ariaSort, nextDirection, sortRows } from "./sort.js";
import {
  debounce,
  downloadJson,
  listSaves,
  loadLocal,
  loadRemote,
  saveLocal,
  saveRemote,
  stateFromRows,
} from "./store.js";

const VOLUME_FIELDS = [
  { key: "pass_attempts", label: "Pass attempts" },
  { key: "carries", label: "Carries" },
  { key: "targets", label: "Targets" },
];

// The columns you type into, and which positions are asked for each. A receiver
// has passing attempts in the model; an input for them would be a decision that
// changes nothing.
const PASSING = ["QB"];
const RUSHING = ["QB", "RB", "FB", "WR", "TE"];
const RECEIVING = ["RB", "FB", "WR", "TE"];

const COUNT_COLUMNS = [
  { key: "pass_attempts", positions: PASSING },
  { key: "passing_yards", positions: PASSING },
  { key: "passing_tds", positions: PASSING, decimals: 1 },
  { key: "interceptions", positions: PASSING, decimals: 1 },
  { key: "carries", positions: RUSHING },
  { key: "rushing_yards", positions: RUSHING },
  { key: "rushing_tds", positions: RUSHING, decimals: 1 },
  { key: "targets", positions: RECEIVING },
  { key: "receptions", positions: RECEIVING },
  { key: "receiving_yards", positions: RECEIVING },
  { key: "receiving_tds", positions: RECEIVING, decimals: 1 },
  { key: "fumbles_lost", positions: RUSHING, decimals: 1 },
];

// Read-outs, in the order they appear. Percentages are shown as such.
const DERIVED_COLUMNS = [
  { key: "yards_per_attempt", decimals: 2 },
  { key: "yards_per_carry", decimals: 2 },
  { key: "yards_per_target", decimals: 2 },
  { key: "catch_rate", decimals: 1, percent: true },
];

// The three counts that come out of a team volume, for the totals row.
const ALLOCATED = [
  { key: "pass_attempts", label: "Att" },
  { key: "carries", label: "Car" },
  { key: "targets", label: "Tgt" },
];

const app = {
  baseline: null,
  state: { teams: {} },
  view: "team",
  team: null,
  format: "ppr",
  // Sort is view state, not projection state — deliberately not persisted, so
  // reopening the page starts from the order that reads best rather than from
  // whatever column was last poked at.
  sort: {
    allocation: { key: "last", direction: "desc" },
    board: { key: "pts", direction: "desc" },
  },
};

// -- helpers ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const round = (value, places = 0) =>
  Number.isFinite(value) ? value.toFixed(places) : "—";
const pct = (value) => `${(value * 100).toFixed(1)}%`;

function banner(message, kind = "") {
  const element = $("banner");
  if (!message) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.textContent = message;
  element.className = kind ? `banner is-${kind}` : "banner";
}

function setSaveState(text, kind = "") {
  const element = $("save-state");
  element.textContent = text;
  element.className = kind ? `save-state is-${kind}` : "save-state";
}

/**
 * The working copy for one team.
 *
 * Seeded from 2025 for display, but *not* saved until something is edited.
 * Opening a team to look at it is not a projection, and if merely selecting one
 * from the dropdown wrote it into state, the board would fill up with teams you
 * never made a single decision about.
 */
function teamState(code) {
  const saved = app.state.teams[code];
  if (saved) return saved;
  const team = app.baseline.teams[code];
  return { volume: seedVolume(team), allocations: seedAllocations(team) };
}

/** Promote the team currently being edited from a seed into saved state. */
function commitTeam(code = app.team) {
  if (!app.state.teams[code]) app.state.teams[code] = teamState(code);
  return app.state.teams[code];
}

/** Teams the user has actually made decisions about. */
function projectedTeams() {
  return Object.keys(app.state.teams);
}

function currentProjection(code = app.team) {
  const working = teamState(code);
  return projectTeam({
    team: app.baseline.teams[code],
    volume: working.volume,
    allocations: working.allocations,
    leagueRates: app.baseline.league_rates,
  });
}

const persist = debounce(() => {
  const stored = saveLocal(app.state);
  setSaveState(stored ? "Saved locally" : "Not saved — storage unavailable",
    stored ? "" : "error");
}, 300);

function touched() {
  setSaveState("Saving…", "dirty");
  persist();
}

// -- team view -------------------------------------------------------------

/**
 * The league scale under a volume box.
 *
 * Answers the question the number cannot answer alone: is 484 pass attempts a
 * lot? The marker is the value currently in the box, so it moves as you type.
 */
function scaleMarkup(field, value) {
  const range = leagueRange(app.baseline.teams, field.key);
  if (!range.count) return "";
  const placed = rankInLeague(app.baseline.teams, field.key, value);
  const left = (fraction) => `${(fraction * 100).toFixed(1)}%`;
  return `
    <div class="scale">
      <div class="scale-track">
        <span class="scale-median" style="left:${left(positionInRange(range.median, range))}"></span>
        <span class="scale-marker" style="left:${left(positionInRange(value, range))}"></span>
      </div>
      <div class="scale-labels">
        <span>${Math.round(range.min)}</span>
        <span class="mid" style="left:${left(positionInRange(range.median, range))}">med ${Math.round(range.median)}</span>
        <span>${Math.round(range.max)}</span>
      </div>
      <div class="scale-rank">
        would rank <b>${ordinal(placed.rank)}</b> of ${placed.of} in 2025
      </div>
    </div>`;
}

function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

function renderVolume() {
  const team = app.baseline.teams[app.team];
  const working = teamState(app.team);
  $("volume-grid").innerHTML = VOLUME_FIELDS.map((field) => {
    const value = working.volume[field.key] || 0;
    const last = Math.round(team.totals_2025[field.key] || 0);
    const vacated = Math.round(team.vacated_2025[field.key] || 0);
    const delta = value - last;
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "";
    const sign = delta > 0 ? "+" : "";
    return `
      <div class="volume-card">
        <label for="vol-${field.key}">${field.label}</label>
        <input type="number" id="vol-${field.key}" data-volume="${field.key}"
               value="${value}" min="0" step="1" />
        <div class="meta">
          <span>2025: ${last}${delta ? ` <span class="delta ${direction}">${sign}${delta}</span>` : ""}</span>
          <span title="Volume whose 2025 producer is no longer on the roster">${vacated} vacated</span>
        </div>
        ${scaleMarkup(field, value)}
      </div>`;
  }).join("");

  for (const input of $("volume-grid").querySelectorAll("input[data-volume]")) {
    input.addEventListener("input", (event) => {
      const key = event.target.dataset.volume;
      commitTeam().volume[key] = Math.max(0, Number(event.target.value) || 0);
      touched();
      renderAllocation();
      renderVolumeMeta();
    });
  }
}

/** Repaint only the 2025-comparison line, so typing does not steal focus. */
function renderVolumeMeta() {
  const team = app.baseline.teams[app.team];
  const working = teamState(app.team);
  for (const field of VOLUME_FIELDS) {
    const card = $(`vol-${field.key}`)?.closest(".volume-card");
    if (!card) continue;
    const last = Math.round(team.totals_2025[field.key] || 0);
    const delta = (working.volume[field.key] || 0) - last;
    const direction = delta > 0 ? "up" : delta < 0 ? "down" : "";
    const sign = delta > 0 ? "+" : "";
    card.querySelector(".meta span").innerHTML =
      `2025: ${last}${delta ? ` <span class="delta ${direction}">${sign}${delta}</span>` : ""}`;

    // Replacing the scale wholesale is safe — it holds no focusable element, so
    // the cursor stays in the box being typed into.
    const scale = card.querySelector(".scale");
    if (scale) {
      scale.outerHTML = scaleMarkup(field, working.volume[field.key] || 0);
    }
  }
}

/**
 * One row's worth of values, before any of it becomes HTML.
 *
 * Sorting needs numbers to compare, not the strings they are rendered as, so
 * the table is built in two passes: values here, markup after the sort. The
 * counts are what you typed; the rates and the points are arithmetic on them.
 */
function allocationRows() {
  const team = app.baseline.teams[app.team];
  const working = teamState(app.team);
  const projection = currentProjection();
  const projected = new Map(projection.players.map((p) => [p.player_id, p]));

  return team.roster
    .filter((entry) => PROJECTED_POSITIONS.has(entry.position))
    .map((entry) => {
      const allocation = working.allocations[entry.player_id] || {};
      const counts = statsFromCounts(allocation.counts || {});
      const result = projected.get(entry.player_id);
      const rates = derivedRates(counts);
      return {
        entry,
        allocation,
        counts,
        rates,
        result,
        player: entry.player,
        position: entry.position,
        last: baselinePoints(entry, app.format),
        ...counts,
        // A rate a position never produces should not sort against the ones
        // that do — a receiver's absent yards per attempt is not a low one.
        ...Object.fromEntries(
          DERIVED_COLUMNS.map((spec) => [spec.key, rates[spec.key]]),
        ),
        pts: result?.points[app.format] ?? null,
        ppg: result?.per_game[app.format] ?? null,
      };
    });
}

const countInputs = (row) =>
  COUNT_COLUMNS.map((spec) => {
    if (!spec.positions.includes(row.position)) return '<td class="num">—</td>';
    const value = row.counts[spec.key];
    return `<td class="num">
      <input class="count-cell" type="number" min="0" step="${spec.decimals ? "0.5" : "1"}"
             data-player="${row.entry.player_id}" data-count="${spec.key}"
             value="${value.toFixed(spec.decimals || 0)}" />
    </td>`;
  }).join("");

const derivedCells = (row) =>
  DERIVED_COLUMNS.map((spec) => {
    const value = row.rates[spec.key];
    if (value === null) return '<td class="num derived">—</td>';
    const shown = spec.percent ? value * 100 : value;
    return `<td class="num derived">${shown.toFixed(spec.decimals)}</td>`;
  }).join("");

function allocationRowMarkup(row) {
  const { entry, result } = row;

  const tags = [];
  if (entry.is_rookie) tags.push('<span class="tag tag-rookie">rookie</span>');
  else if (!entry.played_here_2025) {
    tags.push(`<span class="tag tag-new">${entry.team_2025 || "new"}</span>`);
  }

  return `
    <tr>
      <td class="sticky-col">
        <button class="player-link" data-card="${entry.player_id}"
                title="Recent seasons">${entry.player}</button>${tags.join("")}
      </td>
      <td>${entry.position}</td>
      <td class="num">${row.last === null ? "—" : round(row.last, 0)}</td>
      ${countInputs(row)}
      ${derivedCells(row)}
      <td class="num">${result ? round(row.pts, 1) : "—"}</td>
      <td class="num">${result ? round(row.ppg, 1) : "—"}</td>
    </tr>`;
}

/**
 * The totals row, at the top where the numbers being spent are visible while
 * you spend them rather than a scroll below the last player.
 *
 * Only the three counts that come out of a team volume get a comparison; the
 * rest are simply summed, because nothing constrains how many touchdowns an
 * offence scores.
 */
function renderTotals(projection, working) {
  const cell = (spec) => {
    const total = projection.totals[spec.key] || 0;
    const budget = working.volume[spec.key];
    if (budget === undefined) {
      return `<td class="num">${round(total, spec.decimals || 0)}</td>`;
    }
    const left = budget - total;
    const state = Math.abs(left) < 0.5 ? "exact" : left < 0 ? "over" : "under";
    return `<td class="num ${state}" title="${budget} in the volume above, ${round(Math.abs(left))} ${left < 0 ? "over" : "left"}">${round(total)}</td>`;
  };

  const unassigned = ALLOCATED.filter(
    (spec) => Math.abs(projection.unassigned[spec.key]) >= 0.5,
  );

  $("allocation-totals").innerHTML = `
    <th class="sticky-col">Allocated</th>
    <td></td>
    <td></td>
    ${COUNT_COLUMNS.map(cell).join("")}
    ${DERIVED_COLUMNS.map(() => '<td class="num derived"></td>').join("")}
    <td class="num">${round(
      projection.players.reduce((sum, p) => sum + p.points[app.format], 0),
      1,
    )}</td>
    <td></td>`;

  $("allocation-hint").textContent = unassigned.length
    ? `Type the numbers you expect. ${unassigned
        .map((spec) => {
          const left = projection.unassigned[spec.key];
          return `${Math.abs(Math.round(left))} ${spec.label.toLowerCase()} ${left < 0 ? "over" : "left"}`;
        })
        .join(", ")} against the team volume above.`
    : "Type the numbers you expect. Every category matches the team volume above.";
}

function renderAllocation() {
  const working = teamState(app.team);
  const projection = currentProjection();
  const sorted = sortRows(
    allocationRows(),
    app.sort.allocation.key,
    app.sort.allocation.direction,
  );

  $("allocation-body").innerHTML =
    sorted.map(allocationRowMarkup).join("") ||
    '<tr><td colspan="21" class="empty">No skill players on this roster.</td></tr>';

  renderTotals(projection, working);
  bindCountInputs();
  bindPlayerCards();
  markSortedHeader("allocation-head", app.sort.allocation);
}

/** Reflect the current sort on the headers, for sighted and screen readers alike. */
function markSortedHeader(headId, current) {
  const head = $(headId);
  if (!head) return;
  for (const th of head.querySelectorAll("th[data-sort]")) {
    th.setAttribute("aria-sort", ariaSort(current, th.dataset.sort));
  }
}

/**
 * Make a header row sortable.
 *
 * Bound once at boot rather than on every render — the headers are static, and
 * rebinding them each repaint would stack listeners until one click sorted the
 * table a dozen times.
 */
function bindSortableHeader(headId, target, rerender) {
  const head = $(headId);
  if (!head) return;
  for (const th of head.querySelectorAll("th[data-sort]")) {
    th.tabIndex = 0;
    th.setAttribute("role", "columnheader");
    const activate = () => {
      const key = th.dataset.sort;
      app.sort[target] = {
        key,
        direction: nextDirection(app.sort[target], key, th.dataset.type || "number"),
      };
      rerender();
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  }
}

function renderAllocationFoot(projection, working) {
  const cells = SHARE_FIELDS.map((field) => {
    const allocated = projection.allocated[field.key];
    const state =
      Math.abs(allocated - 1) < 0.005 ? "exact" : allocated > 1 ? "over" : "under";
    return `<td class="num ${state}">${pct(allocated)}</td>`;
  }).join("");

  const totals = projection.players.reduce(
    (sum, player) => sum + player.points[app.format],
    0,
  );

  $("allocation-foot").innerHTML = `
    <tr>
      <td class="sticky-col">Allocated</td>
      <td></td><td></td><td></td>
      ${cells}
      <td class="num">${round(working.volume.pass_attempts)}</td>
      <td class="num">${round(working.volume.carries)}</td>
      <td class="num">${round(working.volume.targets)}</td>
      <td></td><td></td>
      <td class="num">${round(totals, 1)}</td>
      <td></td>
    </tr>`;
}

/**
 * Repaint the derived cells of one row without touching its inputs.
 *
 * Rebuilding the row would take the cursor with it, so the rates, points and
 * the totals are written in place while you type.
 */
function repaintRow(rowElement, playerId) {
  const working = teamState(app.team);
  const counts = statsFromCounts(working.allocations[playerId]?.counts || {});
  const rates = derivedRates(counts);
  const points = fantasyPoints(counts);

  const derived = rowElement.querySelectorAll("td.derived");
  DERIVED_COLUMNS.forEach((spec, index) => {
    const value = rates[spec.key];
    derived[index].textContent =
      value === null ? "—" : (spec.percent ? value * 100 : value).toFixed(spec.decimals);
  });

  const numeric = rowElement.querySelectorAll("td.num");
  numeric[numeric.length - 2].textContent = round(points[app.format], 1);
  numeric[numeric.length - 1].textContent = round(points[app.format] / 17, 1);
}

/** Make sure a player has an allocation to write into before writing to it. */
function allocationFor(playerId) {
  const working = commitTeam();
  if (!working.allocations[playerId]) {
    working.allocations[playerId] = { counts: statsFromCounts({}) };
  }
  if (!working.allocations[playerId].counts) {
    working.allocations[playerId].counts = statsFromCounts({});
  }
  return working.allocations[playerId];
}

function bindCountInputs() {
  for (const input of $("allocation-body").querySelectorAll("input[data-count]")) {
    input.addEventListener("input", (event) => {
      const { player, count } = event.target.dataset;
      const raw = event.target.value.trim();
      // A cleared box is on its way to a number, not a zero to act on yet.
      if (raw === "") return;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return;

      allocationFor(player).counts[count] = value;
      touched();
      repaintRow(event.target.closest("tr"), player);
      renderTotals(currentProjection(), teamState(app.team));
    });
  }
}

function bindPlayerCards() {
  for (const button of $("allocation-body").querySelectorAll("button[data-card]")) {
    button.addEventListener("click", () => openPlayerCard(button.dataset.card));
  }
}

function renderTeamView() {
  renderVolume();
  renderAllocation();
}

// -- board view ------------------------------------------------------------

function renderBoard() {
  const format = $("board-format").value;
  const position = $("board-position").value;

  // Only teams you have actually opened have projections; the rest would just
  // be last season repeated back at you, which is not a projection.
  const codes = projectedTeams();
  if (!codes.length) {
    $("board-body").innerHTML =
      '<tr><td colspan="12" class="empty">Project a team first — the board ranks what you have built.</td></tr>';
    $("board-hint").textContent = "";
    return;
  }

  const projections = codes.map((code) => currentProjection(code));
  const ranks = positionalRanks(projections, format);

  const rows = projections.flatMap((projection) =>
    projection.players.map((player) => {
      const { stats } = player;
      return {
        player: player.player,
        position: player.position,
        team: projection.team,
        // Sorting on the number groups QB1, QB2, QB3 rather than interleaving
        // every position's firsts; the label carries the position for reading.
        rank: ranks.get(player.player_id),
        rankLabel: `${player.position}${ranks.get(player.player_id)}`,
        games: player.games,
        att: stats.pass_attempts,
        car: stats.carries,
        rec: stats.receptions,
        yds: stats.passing_yards + stats.rushing_yards + stats.receiving_yards,
        td: stats.passing_tds + stats.rushing_tds + stats.receiving_tds,
        pts: player.points[format],
        ppg: player.per_game[format],
      };
    }),
  );

  const visible = sortRows(
    rows.filter((row) => position === "ALL" || row.position === position),
    app.sort.board.key,
    app.sort.board.direction,
  );

  $("board-hint").textContent =
    `${visible.length} players across ${codes.length} projected team${codes.length === 1 ? "" : "s"}`;

  $("board-body").innerHTML =
    visible
      .map(
        (row) => `
          <tr>
            <td class="num">${row.rankLabel}</td>
            <td class="sticky-col"><span class="player-name">${row.player}</span></td>
            <td>${row.position}</td>
            <td>${row.team}</td>
            <td class="num">${row.games}</td>
            <td class="num">${round(row.att)}</td>
            <td class="num">${round(row.car)}</td>
            <td class="num">${round(row.rec)}</td>
            <td class="num">${round(row.yds)}</td>
            <td class="num">${round(row.td, 1)}</td>
            <td class="num">${round(row.pts, 1)}</td>
            <td class="num">${round(row.ppg, 1)}</td>
          </tr>`,
      )
      .join("") ||
    '<tr><td colspan="12" class="empty">No players at that position yet.</td></tr>';

  markSortedHeader("board-head", app.sort.board);
}

// -- saving ----------------------------------------------------------------

function buildPayload() {
  const teams = projectedTeams().map((code) => {
    const projection = currentProjection(code);
    const working = teamState(code);
    return {
      team: code,
      volume: projection.volume,
      players: projection.players.map((player) => ({
        ...player,
        // Still written, but derived — the counts are the decision now, and
        // the share is what they came to as a fraction of the team volume.
        shares: {
          pass: projection.volume.pass_attempts
            ? player.stats.pass_attempts / projection.volume.pass_attempts : 0,
          rush: projection.volume.carries
            ? player.stats.carries / projection.volume.carries : 0,
          recv: projection.volume.targets
            ? player.stats.targets / projection.volume.targets : 0,
        },
      })),
    };
  });
  return {
    projection_season: app.baseline.projection_season,
    label: "",
    teams,
  };
}

// -- player card -----------------------------------------------------------

/**
 * Columns per position, because the numbers that matter differ.
 *
 * `derive` gets the season line and returns the cell; rates are computed here
 * rather than stored, so a season with no volume shows a dash instead of a
 * division by zero.
 */
const rate = (numerator, denominator, places = 2) =>
  denominator > 0 ? (numerator / denominator).toFixed(places) : "—";

const CARD_COLUMNS = {
  QB: [
    ["Att", (l) => l.pass_attempts],
    ["Yds", (l) => l.passing_yards],
    ["Y/A", (l) => rate(l.passing_yards, l.pass_attempts)],
    ["Comp %", (l) => rate(l.completions * 100, l.pass_attempts, 0)],
    ["TD", (l) => l.passing_tds],
    ["TD %", (l) => rate(l.passing_tds * 100, l.pass_attempts, 1)],
    ["INT", (l) => l.interceptions],
    ["Car", (l) => l.carries],
    ["Ru yds", (l) => l.rushing_yards],
    ["Ru TD", (l) => l.rushing_tds],
  ],
  RB: [
    ["Car", (l) => l.carries],
    ["Yds", (l) => l.rushing_yards],
    ["Y/C", (l) => rate(l.rushing_yards, l.carries)],
    ["TD", (l) => l.rushing_tds],
    ["Tgt", (l) => l.targets],
    ["Rec", (l) => l.receptions],
    ["Catch %", (l) => rate(l.receptions * 100, l.targets, 0)],
    ["Re yds", (l) => l.receiving_yards],
    ["Y/T", (l) => rate(l.receiving_yards, l.targets)],
    ["Re TD", (l) => l.receiving_tds],
  ],
  WR: [
    ["Tgt", (l) => l.targets],
    ["Rec", (l) => l.receptions],
    ["Catch %", (l) => rate(l.receptions * 100, l.targets, 0)],
    ["Yds", (l) => l.receiving_yards],
    ["Y/T", (l) => rate(l.receiving_yards, l.targets)],
    ["Y/R", (l) => rate(l.receiving_yards, l.receptions)],
    ["TD", (l) => l.receiving_tds],
    ["Car", (l) => l.carries],
    ["Ru yds", (l) => l.rushing_yards],
  ],
};
CARD_COLUMNS.TE = CARD_COLUMNS.WR;
CARD_COLUMNS.FB = CARD_COLUMNS.RB;

// Fetched once, on the first card opened — most sessions never open one, and it
// is as large as the baseline itself.
let historyPromise = null;

function loadHistory() {
  if (!historyPromise) {
    historyPromise = fetch("/data/history.json")
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return historyPromise;
}

async function openPlayerCard(playerId) {
  const entry = app.baseline.teams[app.team].roster.find(
    (row) => row.player_id === playerId,
  );
  if (!entry) return;

  const dialog = $("player-dialog");
  $("card-name").textContent = `${entry.player} · ${entry.position}`;
  $("card-hint").textContent = "Loading…";
  $("card-table").innerHTML = "";
  dialog.showModal();

  const history = await loadHistory();
  const lines = history?.players?.[playerId];
  if (!lines?.length) {
    $("card-hint").textContent = entry.is_rookie
      ? "A rookie — no NFL seasons to show. The projection is running on league medians until you say otherwise."
      : "No NFL seasons on record for him in the last four years.";
    return;
  }

  const columns = CARD_COLUMNS[entry.position] || CARD_COLUMNS.WR;
  $("card-hint").textContent =
    "The seasons behind the rates. Per-game figures are in brackets.";
  $("card-table").innerHTML = `
    <thead>
      <tr>
        <th>Season</th><th>Tm</th><th class="num">G</th>
        ${columns.map(([label]) => `<th class="num">${label}</th>`).join("")}
        <th class="num">PPR</th>
      </tr>
    </thead>
    <tbody>
      ${lines
        .map(
          (line) => `
        <tr>
          <td>${line.season}</td>
          <td>${line.team}</td>
          <td class="num">${line.games}</td>
          ${columns.map(([, derive]) => `<td class="num">${derive(line)}</td>`).join("")}
          <td class="num">${line.fantasy_points_ppr}
            <span class="per-game">(${rate(line.fantasy_points_ppr, line.games, 1)})</span>
          </td>
        </tr>`,
        )
        .join("")}
    </tbody>`;
}

function formatWhen(value) {
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? String(value) : when.toLocaleString();
}

async function openSaves() {
  const dialog = $("saves-dialog");
  $("saves-list").innerHTML = "";
  $("saves-hint").textContent = "Loading…";
  dialog.showModal();

  const auth = authStatus();
  if (auth.required && !auth.signedIn) {
    $("saves-hint").textContent =
      "Sign in with Google to reach your saved projections.";
    return;
  }

  const saves = await listSaves();
  if (!saves.length) {
    $("saves-hint").textContent =
      "Nothing saved yet. Save to BigQuery and it will show up here.";
    return;
  }

  $("saves-hint").textContent =
    "Loading a save replaces what is in this browser now.";
  $("saves-list").innerHTML = saves
    .map(
      (save) => `
        <li>
          <span>
            <span class="save-when">${save.label || formatWhen(save.saved_at)}</span><br />
            <span class="save-meta">${save.players} players · ${save.teams} team${save.teams === 1 ? "" : "s"} · ${formatWhen(save.saved_at)}</span>
          </span>
          <button class="btn btn-ghost" data-load="${save.save_id}">Load</button>
        </li>`,
    )
    .join("");

  for (const button of $("saves-list").querySelectorAll("button[data-load]")) {
    button.addEventListener("click", () => loadSave(button.dataset.load));
  }
}

async function loadSave(saveId) {
  const result = await loadRemote(saveId);
  if (!result.ok) {
    $("saves-hint").textContent = result.error;
    return;
  }
  const restored = stateFromRows(result.rows);
  const teams = Object.keys(restored.teams);
  if (!teams.length) {
    $("saves-hint").textContent = "That save had no players in it.";
    return;
  }

  app.state = restored;
  saveLocal(app.state);
  if (!app.baseline.teams[app.team]) app.team = teams[0];
  $("team-select").value = app.team;
  $("saves-dialog").close();
  renderTeamView();
  if (app.view === "board") renderBoard();
  banner(`Loaded ${teams.length} team(s) from BigQuery.`, "good");
  setSaveState("Restored from a save");
}

async function save() {
  const payload = buildPayload();
  if (!payload.teams.length) {
    banner("Nothing to save yet — project at least one team first.", "error");
    return;
  }
  const auth = authStatus();
  if (auth.required && !auth.signedIn) {
    banner("Sign in with Google to save — your work is already kept in this browser.", "error");
    return;
  }
  const button = $("save-btn");
  button.disabled = true;
  button.textContent = "Saving…";
  const result = await saveRemote(payload);
  button.disabled = false;
  button.textContent = "Save to BigQuery";

  if (result.ok) {
    const players = payload.teams.reduce((sum, team) => sum + team.players.length, 0);
    banner(
      `Saved ${players} players across ${payload.teams.length} team(s) to ${result.table}.`,
      "good",
    );
  } else {
    banner(
      `${result.error} Your work is still saved in this browser — Export writes it to a file.`,
      "error",
    );
  }
}

// -- wiring ----------------------------------------------------------------

function renderIdentity(auth) {
  const label = $("identity");
  const button = $("save-btn");
  if (!auth.configured) {
    label.hidden = true;
    button.title = "";
    return;
  }
  label.hidden = !auth.signedIn;
  label.textContent = auth.email || "";
  // Left clickable when signed out so the reason lands in the banner, where
  // there is room to say what to do about it, rather than in a tooltip.
  button.title = auth.signedIn ? "" : "Sign in with Google to save";
}

function switchView(view) {
  app.view = view;
  for (const tab of $("tabs").querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === view);
  }
  $("view-team").hidden = view !== "team";
  $("view-board").hidden = view !== "board";
  if (view === "board") renderBoard();
}

async function boot() {
  let response;
  try {
    response = await fetch("/data/baseline.json");
    if (!response.ok) throw new Error(String(response.status));
    app.baseline = await response.json();
  } catch {
    banner(
      "Could not load data/baseline.json — build it with `python -m projections.build_baseline`.",
      "error",
    );
    return;
  }

  const stored = loadLocal();
  if (stored?.teams) app.state = stored;

  onAuthChange(renderIdentity);
  try {
    const config = await (await fetch("/api/config")).json();
    await initAuth(
      { clientId: config.google_client_id, required: config.auth_required },
      $("signin-button"),
    );
  } catch (error) {
    // A dashboard that cannot reach its own config is still a usable
    // dashboard — only saving depends on it.
    banner(error.message || "Could not set up Google sign-in.", "error");
  }

  const codes = Object.keys(app.baseline.teams).sort();
  $("team-select").innerHTML = codes
    .map((code) => `<option value="${code}">${code}</option>`)
    .join("");
  app.team = codes.includes(app.state.selected_team) ? app.state.selected_team : codes[0];
  $("team-select").value = app.team;

  $("team-select").addEventListener("change", (event) => {
    app.team = event.target.value;
    // Remembered, so a reload comes back to the team you were working on
    // rather than to whichever is first alphabetically.
    app.state.selected_team = app.team;
    persist();
    renderTeamView();
  });
  $("format-select").addEventListener("change", (event) => {
    app.format = event.target.value;
    renderAllocation();
  });
  $("reset-team").addEventListener("click", () => {
    // Only worth asking about when there is something to lose — resetting a
    // team you have not touched changes nothing.
    const touchedTeam = Boolean(app.state.teams[app.team]);
    if (
      touchedTeam &&
      !window.confirm(`Discard your ${app.team} projection and start from 2025 again?`)
    ) {
      return;
    }
    delete app.state.teams[app.team];
      touched();
    renderTeamView();
  });
  $("load-btn").addEventListener("click", openSaves);
  $("board-format").addEventListener("change", renderBoard);
  $("board-position").addEventListener("change", renderBoard);
  $("save-btn").addEventListener("click", save);
  $("export-btn").addEventListener("click", () =>
    downloadJson(buildPayload(), `projections-${app.baseline.projection_season}.json`),
  );
  for (const tab of $("tabs").querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  bindSortableHeader("allocation-head", "allocation", renderAllocation);
  bindSortableHeader("board-head", "board", renderBoard);

  renderTeamView();
  setSaveState(stored ? "Restored from this browser" : "Saved locally");
}

boot();
