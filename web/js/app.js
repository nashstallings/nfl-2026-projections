/**
 * The dashboard.
 *
 * State is one object: the 2026 volume and per-player counts for every team you
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

// Codes alone make you translate before you can pick. The names are static and
// tiny, and they are not in the baseline because nothing else needs them.
const TEAM_NAMES = {
  ARI: "Arizona", ATL: "Atlanta", BAL: "Baltimore", BUF: "Buffalo",
  CAR: "Carolina", CHI: "Chicago", CIN: "Cincinnati", CLE: "Cleveland",
  DAL: "Dallas", DEN: "Denver", DET: "Detroit", GB: "Green Bay",
  HOU: "Houston", IND: "Indianapolis", JAX: "Jacksonville", KC: "Kansas City",
  LA: "LA Rams", LAC: "LA Chargers", LV: "Las Vegas", MIA: "Miami",
  MIN: "Minnesota", NE: "New England", NO: "New Orleans", NYG: "NY Giants",
  NYJ: "NY Jets", PHI: "Philadelphia", PIT: "Pittsburgh", SEA: "Seattle",
  SF: "San Francisco", TB: "Tampa Bay", TEN: "Tennessee", WAS: "Washington",
};

// The columns you type into, and which positions are asked for each. A receiver
// has passing attempts in the model; an input for them would be a decision that
// changes nothing.
const PASSING = ["QB"];
const RUSHING = ["QB", "RB", "FB", "WR", "TE"];
const RECEIVING = ["RB", "FB", "WR", "TE"];

/**
 * `rate` hangs a calculated read-out under the box that drives it.
 *
 * These used to be four columns of their own, wedged between the numbers you
 * type and the points they produce. A rate belongs to its numerator: yards per
 * target means something under receiving yards and nothing three columns away.
 */
const COUNT_COLUMNS = [
  { key: "pass_attempts", positions: PASSING },
  { key: "passing_yards", positions: PASSING, rate: ["yards_per_attempt", "Y/A", 2] },
  { key: "passing_tds", positions: PASSING, decimals: 1 },
  { key: "interceptions", positions: PASSING, decimals: 1 },
  { key: "carries", positions: RUSHING },
  { key: "rushing_yards", positions: RUSHING, rate: ["yards_per_carry", "Y/C", 2] },
  { key: "rushing_tds", positions: RUSHING, decimals: 1 },
  { key: "targets", positions: RECEIVING },
  { key: "receptions", positions: RECEIVING, rate: ["catch_rate", "catch", 0, true] },
  { key: "receiving_yards", positions: RECEIVING, rate: ["yards_per_target", "Y/T", 2] },
  { key: "receiving_tds", positions: RECEIVING, decimals: 1 },
  { key: "fumbles_lost", positions: RUSHING, decimals: 1 },
];

// The three counts that come out of a team volume, for the totals row.
const ALLOCATED = [
  { key: "pass_attempts", label: "Att" },
  { key: "carries", label: "Car" },
  { key: "targets", label: "Tgt" },
];

// Columns before the stat bands: player, position, and the four figures that
// answer "what does this projection say", which is why they sit at the front.
const LEAD_COLUMNS = 6;
const TOTAL_COLUMNS = LEAD_COLUMNS + COUNT_COLUMNS.length;

const INTRO_KEY = "nfl2026.intro-dismissed";

const app = {
  baseline: null,
  state: { teams: {} },
  view: "team",
  team: null,
  format: "ppr",
  // Camp bodies outnumber the players a projection turns on. They stay one
  // click away rather than in the way; the toggle is per visit, not per team,
  // because "show me everyone" is a mode you are in, not a fact about a roster.
  showQuiet: false,
  openCard: null,
  // Sort is view state, not projection state — deliberately not persisted, so
  // reopening the page starts from the order that reads best rather than from
  // whatever column was last poked at.
  sort: {
    allocation: { key: "pts", direction: "desc" },
    board: { key: "pts", direction: "desc" },
  },
};

// -- helpers ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const round = (value, places = 0) =>
  Number.isFinite(value) ? value.toFixed(places) : "—";

/** A change against last season, with its sign and which way it leans. */
function deltaCell(delta, places = 0) {
  if (!Number.isFinite(delta)) return '<td class="num delta-cell">—</td>';
  if (Math.abs(delta) < 0.5) return '<td class="num delta-cell">0</td>';
  const direction = delta > 0 ? "up" : "down";
  const sign = delta > 0 ? "+" : "−";
  return `<td class="num delta-cell ${direction}">${sign}${Math.abs(delta).toFixed(places)}</td>`;
}

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

const clockTime = () =>
  new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The working copy for one team.
 *
 * Seeded from 2025, and the seed is a real projection — every team is shown and
 * ranked from it. What saved state adds is the record that *you* decided
 * something here, which is what the tuned marker and "tuned only" report.
 */
function teamState(code) {
  const saved = app.state.teams[code];
  if (saved) return saved;
  const team = app.baseline.teams[code];
  return { volume: seedVolume(team), allocations: seedAllocations(team) };
}

/** Promote the team currently being edited from a seed into saved state. */
function commitTeam(code = app.team) {
  if (!app.state.teams[code]) {
    app.state.teams[code] = teamState(code);
    renderTeamOptions();
  }
  return app.state.teams[code];
}

/** Teams the user has actually made decisions about. */
function tunedTeams() {
  return Object.keys(app.state.teams);
}

const isTuned = (code) => Boolean(app.state.teams[code]);

function currentProjection(code = app.team) {
  const working = teamState(code);
  return projectTeam({
    team: app.baseline.teams[code],
    volume: working.volume,
    allocations: working.allocations,
  });
}

const persist = debounce(() => {
  const stored = saveLocal(app.state);
  setSaveState(
    stored ? `Saved in this browser · ${clockTime()}` : "Not saved — storage unavailable",
    stored ? "" : "error",
  );
}, 300);

function touched() {
  setSaveState("Saving…", "dirty");
  persist();
}

// -- team chooser ----------------------------------------------------------

/**
 * The dropdown, with a mark against the teams you have worked on.
 *
 * Rebuilt whenever that set changes, so the answer to "where was I" is in the
 * control you would ask it with rather than somewhere else on the page.
 */
function renderTeamOptions() {
  const select = $("team-select");
  const codes = Object.keys(app.baseline.teams).sort();
  select.innerHTML = codes
    .map((code) => {
      const name = TEAM_NAMES[code] ? ` · ${TEAM_NAMES[code]}` : "";
      return `<option value="${code}">${isTuned(code) ? "✓ " : ""}${code}${name}</option>`;
    })
    .join("");
  select.value = app.team;

  const tuned = tunedTeams().length;
  $("tuned-count").textContent = tuned
    ? `${tuned} of ${codes.length} teams tuned`
    : `All ${codes.length} teams start at their 2025 season`;
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
      renderTotals(currentProjection(), teamState(app.team));
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
      const last = baselinePoints(entry, app.format);
      const pts = result?.points[app.format] ?? null;
      return {
        entry,
        counts,
        rates: derivedRates(counts),
        result,
        player: entry.player,
        position: entry.position,
        last,
        ...counts,
        pts,
        delta: pts === null || last === null ? null : pts - last,
        ppg: result?.per_game[app.format] ?? null,
      };
    });
}

/**
 * Whether a row is worth a line of the table by default.
 *
 * A roster is mostly players who will not touch the ball. Hiding them is not
 * hiding information — anything with volume of its own, or a 2025 season to its
 * name, stays. What goes is the twelve or so rows of zeros that dilute the ten
 * that decide a team.
 */
const isActive = (row) =>
  COUNT_FIELDS.some((field) => row.counts[field] > 0) || (row.last ?? 0) >= 1;

const countInputs = (row) =>
  COUNT_COLUMNS.map((spec) => {
    // An empty cell rather than a dash: twelve dashes a row read as content and
    // are not, and the band above already says which columns a position uses.
    if (!spec.positions.includes(row.position)) return '<td class="num na"></td>';
    return `<td class="num">
      <input class="count-cell" type="number" min="0" step="${spec.decimals ? "0.5" : "1"}"
             data-player="${row.entry.player_id}" data-count="${spec.key}"
             value="${row.counts[spec.key].toFixed(spec.decimals || 0)}" />
      ${spec.rate ? rateCaption(spec, row.rates) : ""}
    </td>`;
  }).join("");

/**
 * The calculated rate that belongs to this box, printed underneath it.
 *
 * A rate with nothing to divide prints nothing at all. "— Y/C" under every
 * receiver's empty rushing box is the dash noise this change was meant to end,
 * arriving by a different door.
 */
function rateCaption(spec, rates) {
  const [key, label, decimals, percent] = spec.rate;
  const value = rates[key];
  const shown =
    value === null
      ? ""
      : `${(percent ? value * 100 : value).toFixed(decimals)}${percent ? "%" : ""} <i>${label}</i>`;
  return `<span class="rate-caption" data-rate="${key}">${shown}</span>`;
}

function allocationRowMarkup(row) {
  const { entry } = row;

  const tags = [];
  if (entry.is_rookie) tags.push('<span class="tag tag-rookie">rookie</span>');
  else if (!entry.played_here_2025) {
    tags.push(`<span class="tag tag-new">${entry.team_2025 || "new"}</span>`);
  }

  return `
    <tr${app.openCard === entry.player_id ? ' class="is-open"' : ""}>
      <td class="sticky-col">
        <button class="player-link" data-card="${entry.player_id}"
                title="Last four seasons">${entry.player}</button>${tags.join("")}
      </td>
      <td>${entry.position}</td>
      <td class="num">${row.last === null ? "—" : round(row.last, 0)}</td>
      <td class="num key-col">${row.pts === null ? "—" : round(row.pts, 1)}</td>
      ${deltaCell(row.delta, 0)}
      <td class="num">${row.ppg === null ? "—" : round(row.ppg, 1)}</td>
      ${countInputs(row)}
    </tr>`;
}

/**
 * The totals row, at the top where the numbers being spent are visible while
 * you spend them rather than a scroll below the last player.
 *
 * The three counts that come out of a team volume carry the budget in the cell
 * — 487 with "161 left" under it — because a bare 487 makes you find the volume
 * box, remember it, and subtract. The rest are simply summed, since nothing
 * constrains how many touchdowns an offence scores.
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
    const caption =
      state === "exact"
        ? `of ${round(budget)}`
        : `${round(Math.abs(left))} ${left < 0 ? "over" : "left"}`;
    return `<td class="num ${state}">
      <span class="tot">${round(total)}</span>
      <span class="tot-caption">${caption}</span>
    </td>`;
  };

  const unassigned = ALLOCATED.filter(
    (spec) => Math.abs(projection.unassigned[spec.key]) >= 0.5,
  );
  const points = projection.players.reduce((sum, p) => sum + p.points[app.format], 0);

  $("allocation-totals").innerHTML = `
    <th class="sticky-col">Allocated</th>
    <td></td>
    <td></td>
    <td class="num key-col">${round(points, 0)}</td>
    <td></td>
    <td></td>
    ${COUNT_COLUMNS.map(cell).join("")}`;

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
  const rows = sortRows(
    allocationRows(),
    app.sort.allocation.key,
    app.sort.allocation.direction,
  );

  const quiet = rows.filter((row) => !isActive(row));
  const shown = app.showQuiet ? rows : rows.filter(isActive);

  const more = quiet.length
    ? `<tr class="more-row"><td colspan="${TOTAL_COLUMNS}">
         <button class="link-button" id="toggle-quiet">${
           app.showQuiet
             ? `Hide ${quiet.length} players with no projected volume`
             : `Show ${quiet.length} more players with no projected volume`
         }</button>
       </td></tr>`
    : "";

  $("allocation-body").innerHTML =
    (shown.map(allocationRowMarkup).join("") ||
      `<tr><td colspan="${TOTAL_COLUMNS}" class="empty">No skill players on this roster.</td></tr>`) +
    more;

  renderTotals(projection, working);
  bindCountInputs();
  bindPlayerCards();
  $("toggle-quiet")?.addEventListener("click", () => {
    app.showQuiet = !app.showQuiet;
    renderAllocation();
  });
  markSortedHeader("allocation-head", app.sort.allocation);
  pinAnswerColumn();
}

/**
 * Tell the 2026 column where the name column ends.
 *
 * The table is auto-laid-out, so the name column is as wide as the longest name
 * on this roster and nothing in the stylesheet can know that number. Measuring
 * it is the only way to freeze the column beside it without either overlapping
 * the names or leaving a gap.
 */
function pinAnswerColumn() {
  const head = document.querySelector("#allocation-head .sticky-col");
  if (!head) return;
  $("allocation-table").style.setProperty(
    "--pin-left",
    `${head.getBoundingClientRect().width}px`,
  );
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

/**
 * Repaint the derived parts of one row without touching its inputs.
 *
 * Rebuilding the row would take the cursor with it, so the points, the change
 * against 2025 and the rate captions are written in place while you type.
 */
function repaintRow(rowElement, playerId, entry) {
  const counts = statsFromCounts(
    teamState(app.team).allocations[playerId]?.counts || {},
  );
  const rates = derivedRates(counts);
  const points = fantasyPoints(counts)[app.format];
  const last = baselinePoints(entry, app.format);

  for (const caption of rowElement.querySelectorAll(".rate-caption")) {
    const spec = COUNT_COLUMNS.find(
      (column) => column.rate && column.rate[0] === caption.dataset.rate,
    );
    const [key, label, decimals, percent] = spec.rate;
    const value = rates[key];
    caption.innerHTML =
      value === null
        ? ""
        : `${(percent ? value * 100 : value).toFixed(decimals)}${percent ? "%" : ""} <i>${label}</i>`;
  }

  rowElement.querySelector(".key-col").textContent = round(points, 1);
  rowElement.querySelector(".delta-cell").outerHTML = deltaCell(
    last === null ? null : points - last,
    0,
  );
  // Lead columns are 2025, 2026, +/−, PPG among the numeric cells; PPG is the
  // fourth, and it is the only one left to write.
  rowElement.querySelectorAll("td.num")[3].textContent = round(points / 17, 1);
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
  const roster = new Map(
    app.baseline.teams[app.team].roster.map((entry) => [entry.player_id, entry]),
  );
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
      repaintRow(event.target.closest("tr"), player, roster.get(player));
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

/**
 * Every team, ranked, from the first second the page is open.
 *
 * This used to show nothing until a team had been edited, on the reasoning that
 * an untouched team is "last season repeated back at you". That is exactly what
 * a baseline is, and it is the thing you tune away from: gating the board
 * behind thirty-two visits hid the whole point of the app until the work was
 * already done. Tuned teams are marked instead, and can be shown alone.
 */
function renderBoard() {
  const format = $("board-format").value;
  const position = $("board-position").value;
  const scope = $("board-teams").value;

  const all = Object.keys(app.baseline.teams).sort();
  const codes = scope === "tuned" ? tunedTeams().sort() : all;
  const tuned = tunedTeams().length;

  if (!codes.length) {
    $("board-body").innerHTML =
      '<tr><td colspan="13" class="empty">No teams tuned yet — switch to All 32 to see the league on its 2025 baseline.</td></tr>';
    $("board-hint").textContent = "";
    return;
  }

  const projections = codes.map((code) => currentProjection(code));
  const ranks = positionalRanks(projections, format);
  const rosters = new Map(
    codes.map((code) => [
      code,
      new Map(app.baseline.teams[code].roster.map((entry) => [entry.player_id, entry])),
    ]),
  );

  const rows = projections.flatMap((projection) =>
    projection.players.map((player) => {
      const { stats } = player;
      const entry = rosters.get(projection.team).get(player.player_id);
      const pts = player.points[format];
      const last = baselinePoints(entry, format);
      return {
        player: player.player,
        position: player.position,
        team: projection.team,
        tuned: isTuned(projection.team),
        // Sorting on the number groups QB1, QB2, QB3 rather than interleaving
        // every position's firsts; the label carries the position for reading.
        rank: ranks.get(player.player_id),
        rankLabel: `${player.position}${ranks.get(player.player_id)}`,
        att: stats.pass_attempts,
        car: stats.carries,
        rec: stats.receptions,
        yds: stats.passing_yards + stats.rushing_yards + stats.receiving_yards,
        td: stats.passing_tds + stats.rushing_tds + stats.receiving_tds,
        pts,
        last,
        delta: last === null ? null : pts - last,
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
    `${visible.length} players · ${tuned} of ${all.length} teams tuned, the rest on their 2025 baseline`;

  $("board-body").innerHTML =
    visible
      .map(
        (row) => `
          <tr>
            <td class="num">${row.rankLabel}</td>
            <td class="sticky-col"><span class="player-name">${row.player}</span></td>
            <td>${row.position}</td>
            <td>${row.team}${
              row.tuned ? '<span class="tuned-dot" title="You have tuned this team">✓</span>' : ""
            }</td>
            <td class="num key-col">${round(row.pts, 1)}</td>
            <td class="num">${row.last === null ? "—" : round(row.last, 0)}</td>
            ${deltaCell(row.delta, 0)}
            <td class="num">${round(row.ppg, 1)}</td>
            <td class="num">${round(row.att)}</td>
            <td class="num">${round(row.car)}</td>
            <td class="num">${round(row.rec)}</td>
            <td class="num">${round(row.yds)}</td>
            <td class="num">${round(row.td, 1)}</td>
          </tr>`,
      )
      .join("") ||
    '<tr><td colspan="13" class="empty">No players at that position.</td></tr>';

  markSortedHeader("board-head", app.sort.board);
}

// -- saving ----------------------------------------------------------------

/**
 * What gets written to BigQuery: the teams you decided something about.
 *
 * The board shows all 32 so there is something to read from the start; a save
 * is a record of your work, and thirty-one untouched baselines are not that.
 */
function buildPayload() {
  const teams = tunedTeams().map((code) => {
    const projection = currentProjection(code);
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

// -- player history --------------------------------------------------------

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

function markOpenRow(playerId) {
  for (const row of $("allocation-body").querySelectorAll("tr.is-open")) {
    row.classList.remove("is-open");
  }
  if (!playerId) return;
  $("allocation-body")
    .querySelector(`button[data-card="${playerId}"]`)
    ?.closest("tr")
    ?.classList.add("is-open");
}

function closePlayerCard() {
  app.openCard = null;
  $("player-panel").hidden = true;
  document.body.classList.remove("with-panel");
  markOpenRow(null);
  pinAnswerColumn();
}

/**
 * Open a player's last four seasons beside the table.
 *
 * It was a modal, which made reading it and using it mutually exclusive: you
 * looked up what a receiver did on 120 targets, closed the dialog, then typed
 * the number from memory. Docked, the page gives up some width and the history
 * stays next to the box it is informing.
 */
async function openPlayerCard(playerId) {
  const entry = app.baseline.teams[app.team].roster.find(
    (row) => row.player_id === playerId,
  );
  if (!entry) return;
  // Clicking the open player's name again closes it, the way a toggle should.
  if (app.openCard === playerId) {
    closePlayerCard();
    return;
  }

  app.openCard = playerId;
  markOpenRow(playerId);
  $("card-name").textContent = `${entry.player} · ${entry.position}`;
  $("card-hint").textContent = "Loading…";
  $("card-table").innerHTML = "";
  $("player-panel").hidden = false;
  document.body.classList.add("with-panel");
  pinAnswerColumn();

  const history = await loadHistory();
  // Another name may have been clicked while this one was still loading.
  if (app.openCard !== playerId) return;

  const lines = history?.players?.[playerId];
  if (!lines?.length) {
    $("card-hint").textContent = entry.is_rookie
      ? "A rookie — no NFL seasons to show. Everything here is your call."
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
      "Nothing saved yet. Save a projection and it will show up here.";
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
  renderTeamOptions();
  $("saves-dialog").close();
  closePlayerCard();
  renderTeamView();
  if (app.view === "board") renderBoard();
  banner(`Loaded ${teams.length} team(s) from BigQuery.`, "good");
  setSaveState("Restored from a save");
}

async function save() {
  const payload = buildPayload();
  if (!payload.teams.length) {
    banner("Nothing to save yet — change something on a team first.", "error");
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
  button.textContent = "Save";

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
    button.title = "Save this projection to BigQuery";
    return;
  }
  label.hidden = !auth.signedIn;
  label.textContent = auth.email || "";
  // Left clickable when signed out so the reason lands in the banner, where
  // there is room to say what to do about it, rather than in a tooltip.
  button.title = auth.signedIn
    ? "Save this projection to BigQuery"
    : "Sign in with Google to save";
}

function switchView(view) {
  app.view = view;
  for (const tab of $("tabs").querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === view);
  }
  $("view-team").hidden = view !== "team";
  $("view-board").hidden = view !== "board";
  if (view === "board") {
    // The panel is docked beside the allocation table and belongs to it.
    closePlayerCard();
    renderBoard();
  }
}

function setUpIntro() {
  let dismissed = false;
  try {
    dismissed = window.localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    // A browser that refuses storage gets the note every time, which is a much
    // smaller problem than the boot failing over it.
  }
  $("intro").hidden = dismissed;
  $("intro-dismiss").addEventListener("click", () => {
    $("intro").hidden = true;
    try {
      window.localStorage.setItem(INTRO_KEY, "1");
    } catch {
      // Nothing to do — it comes back next time.
    }
  });
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
  app.team = codes.includes(app.state.selected_team) ? app.state.selected_team : codes[0];
  renderTeamOptions();
  setUpIntro();

  $("team-select").addEventListener("change", (event) => {
    app.team = event.target.value;
    // Remembered, so a reload comes back to the team you were working on
    // rather than to whichever is first alphabetically.
    app.state.selected_team = app.team;
    persist();
    closePlayerCard();
    renderTeamView();
  });
  $("format-select").addEventListener("change", (event) => {
    app.format = event.target.value;
    renderAllocation();
  });
  $("reset-team").addEventListener("click", () => {
    // Only worth asking about when there is something to lose — resetting a
    // team you have not touched changes nothing.
    if (
      isTuned(app.team) &&
      !window.confirm(`Discard your ${app.team} projection and start from 2025 again?`)
    ) {
      return;
    }
    delete app.state.teams[app.team];
    touched();
    renderTeamOptions();
    renderTeamView();
  });
  $("load-btn").addEventListener("click", openSaves);
  $("board-format").addEventListener("change", renderBoard);
  $("board-position").addEventListener("change", renderBoard);
  $("board-teams").addEventListener("change", renderBoard);
  $("save-btn").addEventListener("click", save);
  $("export-btn").addEventListener("click", () =>
    downloadJson(buildPayload(), `projections-${app.baseline.projection_season}.json`),
  );
  $("card-close").addEventListener("click", closePlayerCard);
  // The name column's width moves with the window, and so must the offset the
  // frozen 2026 column is pinned at.
  window.addEventListener("resize", debounce(pinAnswerColumn, 150));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.openCard) closePlayerCard();
  });
  for (const tab of $("tabs").querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }
  bindSortableHeader("allocation-head", "allocation", renderAllocation);
  bindSortableHeader("board-head", "board", renderBoard);

  renderTeamView();
  setSaveState(stored ? "Restored from this browser" : "Saved in this browser");
}

boot();
