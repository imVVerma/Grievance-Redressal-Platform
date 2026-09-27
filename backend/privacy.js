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

const HOUR_MS = 3600 * 1000;

// SQLite's CURRENT_TIMESTAMP is UTC and renders as "YYYY-MM-DD HH:MM:SS". That
// is not ISO-8601, so `new Date(value)` parses it as *local* time in V8 and
// would truncate to the wrong hour for anyone outside UTC. The components are
// therefore read out and rebuilt explicitly with Date.UTC.
const SQLITE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function parseSqliteTimestamp(value) {
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

function presentSubmission(row) {
  if (!isAnonymous(row)) return row;

  const presented = { ...row };
  for (const field of SUBMISSION_TIME_FIELDS) {
    presented[field] = bucketTimestamp(row[field]);
  }
  return presented;
}

function presentSubmissions(rows) {
  return rows.map(presentSubmission);
}

// A history row inherits the parent submission's anonymity: the status trail of
// an anonymous grievance is just as deanonymising as its creation time.
function presentHistory(rows, anonymous) {
  if (!anonymous) return rows;
  return rows.map((row) => ({ ...row, changed_at: bucketTimestamp(row.changed_at) }));
}

module.exports = {
  bucketTimestamp,
  presentSubmission,
  presentSubmissions,
  presentHistory,
};
