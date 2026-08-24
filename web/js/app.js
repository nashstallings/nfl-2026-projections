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
  effectiveRates,
  positionalRanks,
  projectTeam,
  rateSources,
  seedAllocations,
  seedVolume,
} from "./projection.js";
import {
  debounce,
  downloadJson,
  loadLocal,
  saveLocal,
  saveRemote,
} from "./store.js";

const VOLUME_FIELDS = [
  { key: "pass_attempts", label: "Pass attempts" },
  { key: "carries", label: "Carries" },
  { key: "targets", label: "Targets" },
];

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
  }
}

function renderAllocation() {
  const team = app.baseline.teams[app.team];
  const working = teamState(app.team);
  const projection = currentProjection();
  const projected = new Map(projection.players.map((p) => [p.player_id, p]));

  const rows = team.roster
    .filter((entry) => PROJECTED_POSITIONS.has(entry.position))
    .map((entry) => {
      const allocation = working.allocations[entry.player_id] || { shares: {} };
      const result = projected.get(entry.player_id);
      const stats = result?.stats;
      const sources = rateSources(entry, app.baseline.league_rates, allocation.rates);
      // Anyone whose efficiency is a positional median rather than his own.
      const estimated = Object.values(sources).some((source) => source === "league");

      const tags = [];
      if (entry.is_rookie) tags.push('<span class="tag tag-rookie">rookie</span>');
      else if (!entry.played_here_2025) {
        tags.push(`<span class="tag tag-new">${entry.team_2025 || "new"}</span>`);
      }

      const baseline = entry.baseline;
      const lastYear = baseline
        ? `${round(baseline.fantasy_points_ppr, 0)} pts`
        : "—";

      const shareInputs = SHARE_FIELDS.map((field) => {
        const share = allocation.shares?.[field.key] || 0;
        const teamVolume = working.volume[field.volume] || 0;
        // A category the team never uses does not need an input for it.
        if (!teamVolume) return '<td class="num">—</td>';
        return `<td class="num">
          <input class="share-input" type="number" step="0.5" min="0" max="100"
                 data-player="${entry.player_id}" data-share="${field.key}"
                 value="${(share * 100).toFixed(1)}" />
        </td>`;
      }).join("");

      const yards = stats
        ? stats.passing_yards + stats.rushing_yards + stats.receiving_yards
        : 0;
      const tds = stats
        ? stats.passing_tds + stats.rushing_tds + stats.receiving_tds
        : 0;

      return `
        <tr class="${estimated ? "is-estimated" : ""}">
          <td class="sticky-col">
            <span class="player-name">${entry.player}</span>${tags.join("")}
          </td>
          <td>${entry.position}</td>
          <td>${lastYear}</td>
          <td class="num">${result?.games ?? 17}</td>
          ${shareInputs}
          <td class="num">${stats ? round(stats.pass_attempts) : "—"}</td>
          <td class="num">${stats ? round(stats.carries) : "—"}</td>
          <td class="num">${stats ? round(stats.targets) : "—"}</td>
          <td class="num">${stats ? round(yards) : "—"}</td>
          <td class="num">${stats ? round(tds, 1) : "—"}</td>
          <td class="num">${result ? round(result.points[app.format], 1) : "—"}</td>
          <td class="num">${result ? round(result.per_game[app.format], 1) : "—"}</td>
        </tr>`;
    });

  $("allocation-body").innerHTML =
    rows.join("") || '<tr><td colspan="14" class="empty">No skill players on this roster.</td></tr>';

  renderAllocationFoot(projection, working);
  bindShareInputs();

  const unassigned = SHARE_FIELDS.filter(
    (field) => Math.abs(projection.unallocated[field.key]) > 0.005,
  );
  $("allocation-hint").textContent = unassigned.length
    ? "Shares are percentages of the team volume above. Anything left unassigned is volume nobody has been given — the row at the bottom tracks it."
    : "Every category is fully allocated.";
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
  const players = projections
    .flatMap((projection) =>
      projection.players.map((player) => ({ ...player, team: projection.team })),
    )
    .filter((player) => position === "ALL" || player.position === position)
    .sort((a, b) => b.points[format] - a.points[format]);

  $("board-hint").textContent =
    `${players.length} players across ${codes.length} projected team${codes.length === 1 ? "" : "s"}`;

  $("board-body").innerHTML =
    players
      .map((player) => {
        const { stats } = player;
        const yards = stats.passing_yards + stats.rushing_yards + stats.receiving_yards;
        const tds = stats.passing_tds + stats.rushing_tds + stats.receiving_tds;
        return `
          <tr>
            <td class="num">${player.position}${ranks.get(player.player_id)}</td>
            <td class="sticky-col"><span class="player-name">${player.player}</span></td>
            <td>${player.position}</td>
            <td>${player.team}</td>
            <td class="num">${player.games}</td>
            <td class="num">${round(stats.pass_attempts)}</td>
            <td class="num">${round(stats.carries)}</td>
            <td class="num">${round(stats.receptions)}</td>
            <td class="num">${round(yards)}</td>
            <td class="num">${round(tds, 1)}</td>
            <td class="num">${round(player.points[format], 1)}</td>
            <td class="num">${round(player.per_game[format], 1)}</td>
          </tr>`;
      })
      .join("") ||
    '<tr><td colspan="12" class="empty">No players at that position yet.</td></tr>';
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

async function save() {
  const payload = buildPayload();
  if (!payload.teams.length) {
    banner("Nothing to save yet — project at least one team first.", "error");
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
    delete app.state.teams[app.team];
    touched();
    renderTeamView();
  });
  $("board-format").addEventListener("change", renderBoard);
  $("board-position").addEventListener("change", renderBoard);
  $("save-btn").addEventListener("click", save);
  $("export-btn").addEventListener("click", () =>
    downloadJson(buildPayload(), `projections-${app.baseline.projection_season}.json`),
  );
  for (const tab of $("tabs").querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  }

  renderTeamView();
  setSaveState(stored ? "Restored from this browser" : "Saved locally");
}

boot();
