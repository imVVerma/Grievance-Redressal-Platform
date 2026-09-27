// Small presentational component — maps a status value to a label + color.
// The vocabulary itself lives in ./statuses so it can be shared without
// breaking fast refresh here.

import { statusMeta } from "./statuses";

export default function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return (
    // Only the per-status background stays inline, because it is data rather
    // than a theme decision. Typography, radius and spacing come from
    // .status-badge so badges match the rest of the surfaces.
    <span className="status-badge" style={{ backgroundColor: meta.color }}>
      {meta.label}
    </span>
  );
}
