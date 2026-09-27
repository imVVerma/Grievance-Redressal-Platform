// Display-layer privacy transforms — design doc §2.2, "Metadata leakage".
//
// A precise timestamp can deanonymise an anonymous submitter on its own: if only
// one person was in a building at 14:37, the minute is the identity. So the
// timestamps shown for an anonymous submission are rounded down to the start of
// their hour.
//
// Nothing in this file touches the database. Every function is a pure transform
// applied to rows *after* they have been read back, which is what makes this safe:
//
//   * the stored value in submissions.created_at / updated_at is never modified;
//   * ORDER BY created_at keeps sorting on the real, unbucketed column, so two
//     anonymous submissions made in the same hour still sort by their true
//     chronological order even though they display an identical hour.
//
// This module also owns the wire format for every timestamp the API returns:
// `toUtcIso` converts them to explicit UTC ISO-8601 so no client has to guess
// which zone a bare SQLite timestamp is in. That applies to named rows too —
// unambiguously UTC on the wire is a correctness fix, not a privacy control.

const HOUR_MS = 3600 * 1000;

// SQLite's CURRENT_TIMESTAMP is UTC and renders as "YYYY-MM-DD HH:MM:SS". That
// is not ISO-8601, so `new Date(value)` parses it as *local* time in V8 and
// would truncate to the wrong hour for anyone outside UTC. The components are
// therefore read out and rebuilt explicitly with Date.UTC.
const SQLITE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

// A trailing "Z" or "+05:30" means the value already states its own offset, so
// the Date parser can resolve it correctly and the components must NOT be
// reinterpreted as UTC. Anything without such a marker is a bare SQLite
// timestamp, whose components are UTC by definition.
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseSqliteTimestamp(value) {
  if (typeof value !== 'string') return null;

  if (EXPLICIT_ZONE.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const match = SQLITE_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
}

function formatSqliteTimestamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// "2026-09-27 14:37:52" -> "2026-09-27 14:00:00"
//
// null/undefined pass through so an absent timestamp stays absent rather than
// becoming the string "null". An unrecognised format is also passed through
// rather than mangled, but it warns first: silently forwarding a possibly
// precise timestamp would be failing open, which is the wrong direction for a
// privacy control. The value itself is kept out of the warning.
function bucketTimestamp(value) {
  if (value === null || value === undefined) return value;

  const ms = parseSqliteTimestamp(value);
  if (ms === null) {
    console.warn('privacy: unrecognised timestamp format, left unchanged.');
    return value;
  }

  return formatSqliteTimestamp(Math.floor(ms / HOUR_MS) * HOUR_MS);
}

// The submission columns that carry a timestamp a client can see.
const SUBMISSION_TIME_FIELDS = ['created_at', 'updated_at'];

// A named submission keeps its exact timestamps — bucketing those would only
// degrade the admin's view, since is_anonymous already records that the
// submitter is not anonymous.
function isAnonymous(row) {
  return Boolean(row && row.is_anonymous);
}

// "2026-09-27 14:37:52" -> "2026-09-27T14:37:52Z"
//
// Every timestamp that leaves the API goes through here, so the wire format is
// unambiguous. SQLite's own output carries no zone marker, which means a client
// that hands it straight to `new Date(...)` silently reinterprets UTC as local
// time and lands on the wrong day for anyone west of Greenwich. Emitting an
// explicit UTC instant removes the guesswork.
//
// Only the string format changes. The instant is preserved to the second, and
// this is applied *after* any bucketing, so the hour-rounding that protects
// anonymous submitters is untouched. The function is idempotent: feeding its own
// output back in yields the same string.
function toUtcIso(value) {
  if (value === null || value === undefined) return value;

  const ms = parseSqliteTimestamp(value);
  if (ms === null) {
    // Same fail-safe as bucketTimestamp: warn, then pass the original through
    // rather than guessing at an instant. Forwarding a value we cannot parse is
    // not a privacy risk here — bucketing has already been decided upstream.
    console.warn('privacy: unrecognised timestamp format, left unchanged.');
    return value;
  }

  // toISOString() would add ".000"; the stored resolution is whole seconds, so
  // the milliseconds are dropped rather than asserting precision that is not
  // there. The result ends in "Z", so it is a valid ISO-8601 instant.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Bucketing (only for anonymous rows) and then the wire format, in that order.
function presentTimestamp(value, anonymous) {
  return toUtcIso(anonymous ? bucketTimestamp(value) : value);
}

function presentSubmission(row) {
  if (!row) return row;

  const anonymous = isAnonymous(row);
  const presented = { ...row };
  for (const field of SUBMISSION_TIME_FIELDS) {
    presented[field] = presentTimestamp(row[field], anonymous);
  }
  return presented;
}

function presentSubmissions(rows) {
  return rows.map(presentSubmission);
}

// A history row inherits the parent submission's anonymity: the status trail of
// an anonymous grievance is just as deanonymising as its creation time.
function presentHistory(rows, anonymous) {
  return rows.map((row) => ({ ...row, changed_at: presentTimestamp(row.changed_at, anonymous) }));
}

module.exports = {
  bucketTimestamp,
  toUtcIso,
  presentSubmission,
  presentSubmissions,
  presentHistory,
};
