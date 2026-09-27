// The status vocabulary for the whole app, in one place — matching the CHECK
// constraint on submissions.status in the backend schema.
//
// `next` is the only status a submission may move to from this one. The list
// view reads it directly, so the UI can never offer a skip or a backward step;
// the backend enforces the same order independently.
const STATUS_META = {
  submitted: { label: "Submitted", color: "#6b7280", next: "acknowledged" },
  acknowledged: { label: "Acknowledged", color: "#2563eb", next: "in_progress" },
  in_progress: { label: "In progress", color: "#b45309", next: "pending_council_review" },
  pending_council_review: { label: "Pending council review", color: "#7c3aed", next: "resolved" },
  resolved: { label: "Resolved", color: "#15803d", next: "closed" },
  closed: { label: "Closed", color: "#374151", next: null },
};

export function statusMeta(status) {
  return STATUS_META[status] ?? { label: status, color: "#6b7280", next: null };
}

export function labelForStatus(status) {
  return statusMeta(status).label;
}

// null means the workflow is finished and no action should be offered.
export function nextStatusFor(status) {
  return statusMeta(status).next;
}
