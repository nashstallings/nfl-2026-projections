/**
 * Where a projection lives between keystrokes.
 *
 * Two tiers, deliberately. The browser holds everything continuously, so
 * closing the tab mid-thought costs nothing and there is no Save button to
 * forget. BigQuery holds the snapshots you choose to keep, because a save you
 * have to ask for is the only kind that means anything — it marks a moment you
 * decided was worth coming back to.
 *
 * Local storage can be unavailable (private windows, blocked site data) and
 * throws on access rather than returning null, so every read and write is
 * guarded and the app runs — losing only persistence — when it fails.
 */

import { authHeader, refresh } from "./auth.js";

const KEY = "nfl-2026-projections/v1";

function readRaw() {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeRaw(value) {
  try {
    window.localStorage.setItem(KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function loadLocal() {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Corrupt or from an older shape. Starting clean beats crashing on boot.
    return null;
  }
}

export function saveLocal(state) {
  return writeRaw(JSON.stringify(state));
}

export function clearLocal() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Coalesce bursts of typing into one write. */
export function debounce(fn, delay = 400) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Whether a refusal is one a fresh token would fix.
 *
 * Distinguishes "your hour is up" from "you are not allowed to write here" —
 * only the first is worth re-prompting for. Re-prompting on the second would
 * ask someone to sign in again to be told no a second time.
 */
export function isStaleToken(status, detail) {
  if (status !== 401) return false;
  const text = String(detail || "").toLowerCase();
  if (text.includes("not permitted") || text.includes("nobody may write")) return false;
  return text.includes("expired") || text.includes("invalid google token")
    || text.includes("missing bearer token");
}

async function postProjections(payload) {
  const response = await fetch("/api/projections", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

/**
 * Push a projection set to BigQuery.
 *
 * Errors are returned rather than thrown: the browser already holds the work,
 * so a failed save is a message to show, not an exception to unwind. One retry,
 * and only after a token refresh actually produced a new token — retrying the
 * same rejected credential just fails twice.
 */
export async function saveRemote(payload) {
  try {
    let { response, body } = await postProjections(payload);

    if (isStaleToken(response.status, body.detail)) {
      const token = await refresh();
      if (token) ({ response, body } = await postProjections(payload));
    }

    if (!response.ok) {
      return { ok: false, error: body.detail || `save failed (${response.status})` };
    }
    return { ok: true, ...body };
  } catch {
    return { ok: false, error: "could not reach the server" };
  }
}

export async function listSaves() {
  try {
    const response = await fetch("/api/projections/saves", {
      headers: authHeader(),
    });
    if (!response.ok) return [];
    const body = await response.json();
    return body.saves || [];
  } catch {
    return [];
  }
}

/** Download the whole projection as a file, for when BigQuery is not reachable. */
export function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Rebuild working state from the rows of a saved projection.
 *
 * The table stores the stat line beside the team volume it came out of, and the
 * stat line is now what you typed — so a save is enough to put you back where
 * you were without consulting the baseline. A projection you cannot reopen is a
 * backup, not an archive.
 *
 * Rows are external data. A malformed one is skipped rather than allowed to
 * abort the load and lose the rest of the save with it.
 */
export function stateFromRows(rows) {
  const teams = {};
  for (const row of rows || []) {
    const code = row?.team;
    const playerId = row?.player_id;
    if (!code || !playerId) continue;

    if (!teams[code]) {
      teams[code] = {
        volume: {
          pass_attempts: Number(row.team_pass_attempts) || 0,
          carries: Number(row.team_carries) || 0,
          targets: Number(row.team_targets) || 0,
        },
        allocations: {},
      };
    }
    teams[code].allocations[playerId] = {
      counts: {
        pass_attempts: Number(row.pass_attempts) || 0,
        passing_yards: Number(row.passing_yards) || 0,
        passing_tds: Number(row.passing_tds) || 0,
        interceptions: Number(row.interceptions) || 0,
        carries: Number(row.carries) || 0,
        rushing_yards: Number(row.rushing_yards) || 0,
        rushing_tds: Number(row.rushing_tds) || 0,
        targets: Number(row.targets) || 0,
        receptions: Number(row.receptions) || 0,
        receiving_yards: Number(row.receiving_yards) || 0,
        receiving_tds: Number(row.receiving_tds) || 0,
        fumbles_lost: Number(row.fumbles_lost) || 0,
      },
      ...(Number(row.games) ? { games: Number(row.games) } : {}),
    };
  }
  return { teams };
}

/** Fetch one saved projection's rows, defaulting to the most recent. */
export async function loadRemote(saveId) {
  try {
    const url = saveId
      ? `/api/projections/latest?save_id=${encodeURIComponent(saveId)}`
      : "/api/projections/latest";
    const response = await fetch(url, { headers: authHeader() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: body.detail || `load failed (${response.status})` };
    }
    return { ok: true, rows: body.rows || [] };
  } catch {
    return { ok: false, error: "could not reach the server" };
  }
}
