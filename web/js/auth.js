/**
 * Google sign-in for the page.
 *
 * The browser never holds a BigQuery credential. It holds a Google ID token —
 * a short-lived, signed statement of who you are, minted for this app and
 * useless anywhere else. The server checks it against Google's keys and its own
 * allow list, and only then talks to BigQuery on your behalf.
 *
 * Everything except saving works signed out, because the workbench itself needs
 * no identity: it is public NFL data and arithmetic. Only your table is yours.
 */

const GSI_SRC = "https://accounts.google.com/gsi/client";

const state = {
  clientId: "",
  required: false,
  token: null,
  email: null,
  listeners: new Set(),
};

// A refresh in flight. Google's callback is the only way a new token arrives,
// so a promise waiting here is what turns that callback into something a save
// can await.
let pendingRefresh = null;

function announce() {
  for (const listener of state.listeners) listener(status());
}

export function onChange(listener) {
  state.listeners.add(listener);
  listener(status());
  return () => state.listeners.delete(listener);
}

export function status() {
  return {
    required: state.required,
    configured: Boolean(state.clientId),
    signedIn: Boolean(state.token),
    email: state.email,
  };
}

/** The header to send with a write, or nothing when none is needed. */
export function authHeader() {
  if (!state.required) return {};
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("could not load Google sign-in"));
    document.head.appendChild(script);
  });
}

/** Read the address out of a token without trusting it — display only.
 *
 * The server re-verifies the signature on every request, so nothing here is a
 * security decision; this is only so the header can say which account is
 * signed in.
 */
function emailFromToken(token) {
  try {
    const [, payload] = token.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json).email || null;
  } catch {
    return null;
  }
}

function handleCredential(response) {
  state.token = response?.credential || null;
  state.email = state.token ? emailFromToken(state.token) : null;
  if (pendingRefresh) {
    const settle = pendingRefresh.settle;
    pendingRefresh = null;
    settle(state.token);
  }
  announce();
}

/**
 * Ask Google for a fresh token.
 *
 * ID tokens last an hour. An evening spent allocating four teams outlives that
 * comfortably, and the first save afterwards would otherwise fail with an
 * expiry message and no way forward but reloading the page — losing nothing,
 * since the browser holds the work, but for no reason the person can see.
 *
 * Resolves with the new token, or null if the prompt was dismissed or never
 * answered. Never rejects: the caller is a save that already has a fallback.
 */
export function refresh({ timeoutMs = 20000 } = {}) {
  if (!state.clientId || !window.google?.accounts?.id) return Promise.resolve(null);
  if (pendingRefresh) return pendingRefresh.promise;

  let settle;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRefresh = null;
      resolve(null);
    }, timeoutMs);
    settle = (token) => {
      clearTimeout(timer);
      resolve(token);
    };
  });
  pendingRefresh = { promise, settle };

  // disableAutoSelect first, or Google may hand back the same cached token it
  // just told us was stale.
  window.google.accounts.id.disableAutoSelect();
  window.google.accounts.id.prompt();
  return promise;
}

/**
 * Set up sign-in, if the deployment asks for it.
 *
 * Returns quietly when no client id is configured — that is the local case, and
 * a sign-in button that cannot work is worse than no button.
 */
export async function initAuth({ clientId, required }, buttonHost) {
  state.clientId = clientId || "";
  state.required = Boolean(required);
  if (!state.clientId) {
    announce();
    return;
  }

  try {
    await loadScript(GSI_SRC);
  } catch {
    announce();
    throw new Error(
      "Google sign-in could not load — saving will not work until it does.",
    );
  }

  window.google.accounts.id.initialize({
    client_id: state.clientId,
    callback: handleCredential,
    auto_select: true,
    // ID tokens expire after an hour. Without this the first save after a long
    // session fails with a stale token and no way to tell why.
    use_fedcm_for_prompt: true,
  });

  if (buttonHost) {
    window.google.accounts.id.renderButton(buttonHost, {
      type: "standard",
      size: "medium",
      text: "signin",
      shape: "pill",
    });
  }
  window.google.accounts.id.prompt();
  announce();
}

/** Drop the token. Google is not signed out — this app just forgets you. */
export function signOut() {
  state.token = null;
  state.email = null;
  if (state.clientId && window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }
  announce();
}
