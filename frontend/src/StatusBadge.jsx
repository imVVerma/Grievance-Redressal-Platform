// Small presentational component — maps a status value to a label + color.
// The vocabulary itself lives in ./statuses so it can be shared without
// breaking fast refresh here.

import { statusMeta } from "./statuses";

export default function StatusBadge({ status }) {
  const meta = statusMeta(status);
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
