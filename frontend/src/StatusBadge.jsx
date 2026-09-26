// Small presentational component — maps a status value to a label + color.
// Keeping this separate means the status vocabulary lives in one place,
// matching the ENUM in the submissions table.

const STATUS_META = {
  submitted: { label: "Submitted", color: "#6b7280" },
  acknowledged: { label: "Acknowledged", color: "#2563eb" },
  in_progress: { label: "In progress", color: "#b45309" },
  pending_council_review: { label: "Pending council review", color: "#7c3aed" },
  resolved: { label: "Resolved", color: "#15803d" },
  closed: { label: "Closed", color: "#374151" },
};

export default function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: "#6b7280" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "999px",
        fontSize: "0.8rem",
        fontWeight: 600,
        color: "#fff",
        backgroundColor: meta.color,
      }}
    >
      {meta.label}
    </span>
  );
}
