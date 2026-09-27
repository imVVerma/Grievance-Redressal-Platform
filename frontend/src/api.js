// Thin wrapper around the /submissions and /staff endpoints from the Express API.
// Adjust BASE_URL to wherever your backend is running.

const BASE_URL = "http://localhost:4000";

// Every call sends credentials, because staff access is session-based and the
// session lives in a cookie. The SPA and the API are on different origins
// (Vite on :5173, Express on :4000), so without this the browser silently drops
// the session cookie and every staff request looks signed out — which would
// present as "the app forgets my login on every action" rather than as an
// obvious bug.
//
// This is safe because the server pairs it with an explicit CORS origin
// allowlist: a wildcard origin with credentials would let any site make
// authenticated calls, so only the configured origins are accepted.
const WITH_CREDENTIALS = { credentials: "include" };

// Prefer the server's own { error } text over a generic message — the status
// endpoint returns specific, client-safe reasons for a rejected transition.
async function errorMessage(res, fallback) {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Body was not JSON, so fall back to the generic message.
  }
  return fallback;
}

export async function fetchSubmissions() {
  const res = await fetch(`${BASE_URL}/submissions`, WITH_CREDENTIALS);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load submissions"));
  return res.json();
}

// Reference data for the submission form's two dropdowns. Public routes, and
// unlike the rest of the form this is the one thing it genuinely cannot work
// without, so the form treats a failure here as worth showing but not worth
// blocking on.
export async function fetchDepartments() {
  const res = await fetch(`${BASE_URL}/departments`, WITH_CREDENTIALS);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load departments"));
  return res.json();
}

export async function fetchCategories() {
  const res = await fetch(`${BASE_URL}/categories`, WITH_CREDENTIALS);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load categories"));
  return res.json();
}

export async function createSubmission(payload) {
  const res = await fetch(`${BASE_URL}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to submit"));
  return res.json();
}

// Asks the server what it *would* store if this text were submitted. The answer
// is a courtesy to the submitter, not a guarantee: the server re-redacts on the
// way in regardless, because a client-side check is not a safety net.
export async function previewRedaction(payload) {
  const res = await fetch(`${BASE_URL}/submissions/redact-preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to check the text"));
  return res.json();
}

export async function updateSubmissionStatus(id, newStatus, reason) {
  const res = await fetch(`${BASE_URL}/submissions/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_status: newStatus, reason }),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to update status"));
  return res.json();
}

// Triage bounce-back, the two halves of the handshake. Both are POSTs rather
// than a PATCH because both change routing rather than workflow state, and
// keeping them off the /status path means the status state machine cannot be
// reached by a request that never went through its own gate.
export async function bounceSubmission(id, reason) {
  const res = await fetch(`${BASE_URL}/submissions/${id}/bounce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to return it to triage"));
  return res.json();
}

export async function reassignSubmission(id, departmentId, reason) {
  const res = await fetch(`${BASE_URL}/submissions/${id}/reassign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ department_id: departmentId, reason }),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to assign a department"));
  return res.json();
}

// The status code rides along on the thrown error so the Track view can tell
// "no submission has that code" apart from a genuine server or network problem.
export async function lookupSubmissionByToken(token) {
  const res = await fetch(
    `${BASE_URL}/submissions/token/${encodeURIComponent(token.trim())}`,
    WITH_CREDENTIALS
  );
  if (!res.ok) {
    const err = new Error(
      await errorMessage(res, "No submission found for that code.")
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --- Staff session --------------------------------------------------------

// Returns { role, department_id }. A signed-out caller gets { role: null } —
// never an error, because "not signed in" is a normal state the Browse view
// renders, not a failure. Only a genuine transport or 5xx problem throws, and
// the caller falls back to showing no actions at all.
export async function fetchStaffSession() {
  const res = await fetch(`${BASE_URL}/staff/me`, WITH_CREDENTIALS);
  if (!res.ok) throw new Error(await errorMessage(res, "Could not check your session"));
  return res.json();
}

export async function staffLogin(email, password) {
  const res = await fetch(`${BASE_URL}/staff/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) {
    // The server's message is deliberately generic, so a wrong email and a
    // wrong password are indistinguishable here too.
    throw new Error(await errorMessage(res, "Invalid email or password."));
  }
  return res.json();
}

export async function staffLogout() {
  const res = await fetch(`${BASE_URL}/staff/logout`, {
    method: "POST",
    ...WITH_CREDENTIALS,
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not sign out"));
  return res.json();
}
