// Thin wrapper around the /submissions endpoints from the Express API.
// Adjust BASE_URL to wherever your backend is running.

const BASE_URL = "http://localhost:4000";

export async function fetchSubmissions() {
  const res = await fetch(`${BASE_URL}/submissions`);
  if (!res.ok) throw new Error("Failed to load submissions");
  return res.json();
}

export async function createSubmission(payload) {
  const res = await fetch(`${BASE_URL}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to submit");
  return res.json();
}
