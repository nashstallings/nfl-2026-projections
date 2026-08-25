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
