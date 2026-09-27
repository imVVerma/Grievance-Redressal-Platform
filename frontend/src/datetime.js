// Timestamp display, in one place.
//
// Every grievance timestamp is rendered in IST regardless of where the viewer is
// or what their device clock is set to. A bare `toLocaleString()` uses the
// browser's own timezone, so the same submission would read "14:37" to a viewer
// in London and "20:07" to a viewer in Delhi — for a university-local system that
// is simply wrong, because the event happened in IST whoever is looking at it.
// Pinning the zone is also what makes the value auditable: two staff in two
// countries read the same string off the same record.
//
// `en-IN` is chosen for its date conventions (day-first, "27 Sept 2026") rather
// than any timezone effect, since the zone is pinned separately.
//
// The backend sends explicit UTC ISO-8601 with a trailing "Z", so `new Date(...)`
// resolves the instant correctly here and this function only decides how to
// write it out for a human.

const DISPLAY_TIME_ZONE = "Asia/Kolkata";

const DISPLAY_FORMAT = {
  timeZone: DISPLAY_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
};

export function formatTimestamp(value) {
  // A missing or unparseable timestamp renders as a dash rather than
  // "Invalid Date". These are stored DATETEs that are always present in
  // practice, so this is a guard against a malformed row, not a real case.
  if (value === null || value === undefined || value === "") return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("en-IN", DISPLAY_FORMAT);
}

export { DISPLAY_TIME_ZONE, DISPLAY_FORMAT };
