// Thin wrapper around the /submissions endpoints from the Express API.
// Adjust BASE_URL to wherever your backend is running.

const BASE_URL = "http://localhost:4000";

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
  const res = await fetch(`${BASE_URL}/submissions`);
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load submissions"));
  return res.json();
}

export async function createSubmission(payload) {
  const res = await fetch(`${BASE_URL}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to submit"));
  return res.json();
}

export async function updateSubmissionStatus(id, newStatus, reason) {
  const res = await fetch(`${BASE_URL}/submissions/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_status: newStatus, reason }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to update status"));
  return res.json();
}
