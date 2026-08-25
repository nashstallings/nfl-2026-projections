/**
 * The dashboard.
 *
 * State is one object: the 2026 volume and per-player shares for every team you
 * have touched. Everything on screen is derived from it by the pure functions in
 * projection.js, so a keystroke updates state, re-derives, and repaints — there
 * is no second copy of a number to fall out of sync.
 */

import {
  PROJECTED_POSITIONS,
  baselinePoints,
  effectiveRates,
  isEstimated,
  leagueRange,
  positionInRange,
  rankInLeague,
  positionalRanks,
  projectTeam,
  rateSources,
  seedAllocations,
  seedVolume,
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

// The rates worth exposing per position — the ones that position's volume
// actually drives. A receiver has passing rates in the model; showing him an
// input for them would be offering a decision that changes nothing.
const RATE_FIELDS = {
  completion_rate: { label: "Comp %", percent: true },
  yards_per_attempt: { label: "Yds/att" },
  pass_td_rate: { label: "Pass TD %", percent: true },
  interception_rate: { label: "INT %", percent: true },
  yards_per_carry: { label: "Yds/carry" },
  rush_td_rate: { label: "Rush TD %", percent: true },
  catch_rate: { label: "Catch %", percent: true },
  yards_per_target: { label: "Yds/target" },
  rec_td_rate: { label: "Rec TD %", percent: true },
  fumble_rate: { label: "Fum/touch %", percent: true },
};

const RATES_BY_POSITION = {
  QB: ["completion_rate", "yards_per_attempt", "pass_td_rate", "interception_rate",
       "yards_per_carry", "rush_td_rate", "fumble_rate"],
  RB: ["yards_per_carry", "rush_td_rate", "catch_rate", "yards_per_target",
       "rec_td_rate", "fumble_rate"],
  WR: ["catch_rate", "yards_per_target", "rec_td_rate", "yards_per_carry",
       "rush_td_rate", "fumble_rate"],
};
RATES_BY_POSITION.TE = RATES_BY_POSITION.WR;
RATES_BY_POSITION.FB = RATES_BY_POSITION.RB;

const SHARE_FIELDS = [
  { key: "pass", volume: "pass_attempts", label: "Att" },
  { key: "rush", volume: "carries", label: "Car" },
  { key: "recv", volume: "targets", label: "Tgt" },
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
  // Player ids whose rate panel is open. View state, not saved.
  expanded: new Set(),
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
 * the table is built in two passes: values here, markup after the sort.
 */
function allocationRows() {
  const team = app.baseline.teams[app.team];
  const working = teamState(app.team);
  const projection = currentProjection();
  const projected = new Map(projection.players.map((p) => [p.player_id, p]));

  return team.roster
    .filter((entry) => PROJECTED_POSITIONS.has(entry.position))
    .map((entry) => {
      const allocation = working.allocations[entry.player_id] || { shares: {} };
      const result = projected.get(entry.player_id);
      const stats = result?.stats;
      return {
        entry,
        allocation,
        result,
        stats,
        // Only counts rates his own volume actually reaches — judging against
        // all of them flags every non-quarterback and says nothing.
        estimated: isEstimated(entry, app.baseline.league_rates, allocation),
        player: entry.player,
        position: entry.position,
        last: baselinePoints(entry, app.format),
        games: allocation.games ?? result?.games ?? 17,
        share_pass: allocation.shares?.pass ?? 0,
        share_rush: allocation.shares?.rush ?? 0,
        share_recv: allocation.shares?.recv ?? 0,
        att: stats?.pass_attempts ?? null,
        car: stats?.carries ?? null,
        tgt: stats?.targets ?? null,
        yds: stats
          ? stats.passing_yards + stats.rushing_yards + stats.receiving_yards
          : null,
        td: stats ? stats.passing_tds + stats.rushing_tds + stats.receiving_tds : null,
        pts: result?.points[app.format] ?? null,
        ppg: result?.per_game[app.format] ?? null,
      };
    });
}

function allocationRowMarkup(row) {
  const working = teamState(app.team);
  const { entry, allocation, result, stats } = row;

  const tags = [];
  if (entry.is_rookie) tags.push('<span class="tag tag-rookie">rookie</span>');
  else if (!entry.played_here_2025) {
    tags.push(`<span class="tag tag-new">${entry.team_2025 || "new"}</span>`);
  }

  const lastYear = row.last === null ? "—" : `${round(row.last, 0)} pts`;

  const shareInputs = SHARE_FIELDS.map((field) => {
    const share = allocation.shares?.[field.key] || 0;
    // A category the team never uses does not need an input for it.
    if (!working.volume[field.volume]) return '<td class="num">—</td>';
    return `<td class="num">
      <input class="share-input" type="number" step="0.5" min="0" max="100"
             data-player="${entry.player_id}" data-share="${field.key}"
             value="${(share * 100).toFixed(1)}" />
    </td>`;
  }).join("");

  return `
    <tr class="${row.estimated ? "is-estimated" : ""}">
      <td class="sticky-col">
        <span class="player-name">${entry.player}</span>${tags.join("")}
        <button class="rates-toggle" data-rates="${entry.player_id}"
                title="Efficiency rates" aria-expanded="${app.expanded.has(entry.player_id)}"
        >${app.expanded.has(entry.player_id) ? "\u2212" : "+"} rates</button>
      </td>
      <td>${entry.position}</td>
      <td>${lastYear}</td>
      <td class="num">
        <input class="games-input" type="number" min="1" max="17" step="1"
               data-player="${entry.player_id}" data-games
               value="${allocation.games ?? 17}" />
      </td>
      ${shareInputs}
      <td class="num">${stats ? round(stats.pass_attempts) : "—"}</td>
      <td class="num">${stats ? round(stats.carries) : "—"}</td>
      <td class="num">${stats ? round(stats.targets) : "—"}</td>
      <td class="num">${stats ? round(row.yds) : "—"}</td>
      <td class="num">${stats ? round(row.td, 1) : "—"}</td>
      <td class="num">${result ? round(row.pts, 1) : "—"}</td>
      <td class="num">${result ? round(row.ppg, 1) : "—"}</td>
    </tr>`;
}

/**
 * The rate panel under a player.
 *
 * Every input is pre-filled with the rate the projection is actually using, so
 * an override starts from the model's answer rather than from an empty box.
 * Clearing one hands the rate back to the model.
 */
function ratesRowMarkup(row) {
  const { entry, allocation } = row;
  if (!app.expanded.has(entry.player_id)) return "";

  const overrides = allocation.rates || {};
  const rates = effectiveRates(entry, app.baseline.league_rates, overrides);
  const sources = rateSources(entry, app.baseline.league_rates, overrides);
  const names = RATES_BY_POSITION[entry.position] || [];

  const fields = names
    .map((name) => {
      const spec = RATE_FIELDS[name];
      const shown = spec.percent ? rates[name] * 100 : rates[name];
      const overridden = sources[name] === "override";
      return `
        <div class="rate-field">
          <label for="rate-${entry.player_id}-${name}">${spec.label}</label>
          <input id="rate-${entry.player_id}-${name}"
                 class="${overridden ? "is-override" : ""}"
                 type="number" step="${spec.percent ? "0.1" : "0.05"}" min="0"
                 data-player="${entry.player_id}" data-rate="${name}"
                 data-percent="${spec.percent ? "1" : ""}"
                 value="${shown.toFixed(spec.percent ? 1 : 2)}" />
        </div>`;
    })
    .join("");

  return `
    <tr class="rates-row">
      <td colspan="14">
        <div class="rates-grid">${fields}</div>
        <p class="rates-note">
          Pre-filled with what the projection is using. Clear a box to hand that
          rate back to the model.
        </p>
      </td>
    </tr>`;
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
    sorted.map((row) => allocationRowMarkup(row) + ratesRowMarkup(row)).join("") ||
    '<tr><td colspan="14" class="empty">No skill players on this roster.</td></tr>';

  renderAllocationFoot(projection, working);
  bindShareInputs();
  bindGamesInputs();
  bindRateInputs();
  bindRateToggles();
  markSortedHeader("allocation-head", app.sort.allocation);

  const unassigned = SHARE_FIELDS.filter(
    (field) => Math.abs(projection.unallocated[field.key]) > 0.005,
  );
  $("allocation-hint").textContent = unassigned.length
    ? "Shares are percentages of the team volume above. Anything left unassigned is volume nobody has been given — the row at the bottom tracks it."
    : "Every category is fully allocated.";
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

/** Make sure a player has an allocation to write into before writing to it. */
function allocationFor(playerId) {
  const working = commitTeam();
  if (!working.allocations[playerId]) {
    working.allocations[playerId] = { shares: { pass: 0, rush: 0, recv: 0 }, rates: {} };
  }
  return working.allocations[playerId];
}

function bindGamesInputs() {
  for (const input of $("allocation-body").querySelectorAll("input[data-games]")) {
    input.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      const allocation = allocationFor(event.target.dataset.player);
      // Out of range means the box is mid-edit, not that the answer is zero.
      if (Number.isFinite(value) && value > 0 && value <= 17) {
        allocation.games = Math.round(value);
        touched();
        repaintDerived();
      }
    });
  }
}

function bindRateInputs() {
  for (const input of $("allocation-body").querySelectorAll("input[data-rate]")) {
    input.addEventListener("input", (event) => {
      const { player, rate, percent } = event.target.dataset;
      const allocation = allocationFor(player);
      allocation.rates = allocation.rates || {};
      const raw = event.target.value.trim();
      if (raw === "") {
        // An empty box is not a rate of zero — it is "you decide".
        delete allocation.rates[rate];
        event.target.classList.remove("is-override");
      } else {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) return;
        allocation.rates[rate] = percent ? value / 100 : value;
        event.target.classList.add("is-override");
      }
      touched();
      repaintDerived();
    });
  }
}

function bindRateToggles() {
  for (const button of $("allocation-body").querySelectorAll("button[data-rates]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.rates;
      if (app.expanded.has(id)) app.expanded.delete(id);
      else app.expanded.add(id);
      renderAllocation();
    });
  }
}

function bindShareInputs() {
  for (const input of $("allocation-body").querySelectorAll("input[data-share]")) {
    input.addEventListener("input", (event) => {
      const { player, share } = event.target.dataset;
      const working = commitTeam();
      if (!working.allocations[player]) {
        working.allocations[player] = { shares: { pass: 0, rush: 0, recv: 0 }, rates: {} };
      }
      const value = Math.max(0, Number(event.target.value) || 0) / 100;
      working.allocations[player].shares[share] = value;
      touched();
      // Repaint the derived columns without rebuilding the inputs, so the
      // cursor stays where it was mid-number.
      repaintDerived();
    });
  }
}

/** Update every computed cell in place, leaving the share inputs untouched. */
function repaintDerived() {
  const projection = currentProjection();
  const projected = new Map(projection.players.map((p) => [p.player_id, p]));
  const rows = $("allocation-body").querySelectorAll("tr");

  for (const row of rows) {
    if (row.classList.contains("rates-row")) continue;
    const input = row.querySelector("input[data-share]");
    if (!input) continue;
    const result = projected.get(input.dataset.player);
    const cells = row.querySelectorAll("td.num");
    // Cells after the three share inputs: att, car, tgt, yds, td, pts, ppg.
    const derived = Array.from(cells).slice(-7);
    if (!result) {
      derived.forEach((cell) => (cell.textContent = "—"));
      continue;
    }
    const { stats } = result;
    const yards = stats.passing_yards + stats.rushing_yards + stats.receiving_yards;
    const tds = stats.passing_tds + stats.rushing_tds + stats.receiving_tds;
    const values = [
      round(stats.pass_attempts), round(stats.carries), round(stats.targets),
      round(yards), round(tds, 1),
      round(result.points[app.format], 1), round(result.per_game[app.format], 1),
    ];
    derived.forEach((cell, index) => (cell.textContent = values[index]));
  }
  renderAllocationFoot(projection, teamState(app.team));
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
        shares: working.allocations[player.player_id]?.shares || {},
      })),
    };
  });
  return {
    projection_season: app.baseline.projection_season,
    label: "",
    teams,
  };
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
  app.expanded.clear();
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
  app.team = codes[0];

  $("team-select").addEventListener("change", (event) => {
    app.team = event.target.value;
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
    app.expanded.clear();
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
