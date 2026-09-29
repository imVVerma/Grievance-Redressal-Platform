const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// Initialize an SQLite database (it will be created automatically in this directory).
//
// GAP_DB_PATH exists so the test suite can point at a throwaway copy instead of
// this file's own gap.db. Without it, a test run has no choice but to run the
// real server against the real database, and "just be careful" is not a
// boundary — the suite would be one bug away from deleting a real grievance.
// Unset in normal use, so this is the same database as before.
const db = new Database(process.env.GAP_DB_PATH || path.join(__dirname, 'gap.db'));

// Initialize tables based on the schema design document
db.exec(`
CREATE TABLE IF NOT EXISTS departments (
    department_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    category_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    submission_type TEXT NOT NULL CHECK (submission_type IN ('request', 'complaint')),
    department_id   INTEGER,
    FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
    user_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Note: location and is_anonymous fields were added for the frontend updates
CREATE TABLE IF NOT EXISTS submissions (
    submission_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_type TEXT NOT NULL CHECK (submission_type IN ('request', 'complaint')),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    category_id     INTEGER,
    department_id   INTEGER,
    -- DEPRECATED / UNUSED. Identity now lives only in the identity_map table,
    -- keyed by submission_token, so that a submission record never carries the
    -- identity of the person behind it. Deliberately left in place: dropping a
    -- column would need a table rebuild and this project has no migration
    -- system. Nothing reads or writes this column any more.
    submitted_by    INTEGER,
    status          TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'acknowledged', 'in_progress', 'pending_council_review', 'resolved', 'closed')),
    location        TEXT,
    is_anonymous    BOOLEAN DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (department_id) REFERENCES departments(department_id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (submitted_by) REFERENCES users(user_id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS status_history (
    history_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id   INTEGER NOT NULL,
    old_status      TEXT,
    new_status      TEXT NOT NULL,
    changed_by      INTEGER,
    reason          TEXT,
    changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (submission_id) REFERENCES submissions(submission_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES users(user_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Triage bounce-back audit trail: a department returning a submission to triage
-- (new_department_id NULL) and triage/admin then routing it to a real department.
--
-- Deliberately a separate table from status_history. Reassigning a submission is
-- not a status transition -- it leaves the status column untouched and does not
-- move the submission along the workflow -- so folding these rows into
-- status_history would put entries with no old_status/new_status into the same
-- ordered timeline that the status state machine reads, and every consumer of
-- that table (including the nextStatus sequence) would then have to know to
-- ignore them.
CREATE TABLE IF NOT EXISTS reassignment_history (
    history_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id       INTEGER NOT NULL,
    old_department_id   INTEGER,
    new_department_id   INTEGER,
    reason              TEXT NOT NULL,
    changed_by          INTEGER,
    changed_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (submission_id) REFERENCES submissions(submission_id) ON DELETE CASCADE,
    FOREIGN KEY (old_department_id) REFERENCES departments(department_id),
    FOREIGN KEY (new_department_id) REFERENCES departments(department_id),
    FOREIGN KEY (changed_by) REFERENCES users(user_id)
);

-- Insert dummy data if empty so the API has something to query
INSERT OR IGNORE INTO departments (department_id, name, description) VALUES 
(1, 'Hostel Maintenance', 'Handles repairs and infrastructure issues in hostels'),
(2, 'Mess Committee', 'Handles food quality and mess-related grievances'),
(3, 'Academic Office', 'Handles course registration and academic complaints');

INSERT OR IGNORE INTO categories (category_id, name, submission_type, department_id) VALUES 
(1, 'Plumbing', 'request', 1),
(2, 'Electrical', 'request', 1),
(3, 'Mess Food Quality', 'complaint', 2),
(4, 'Administrative Coordination', 'complaint', 3);
`);

// --- Identity separation (anonymity token layer) -------------------------
// Runs after the CREATE TABLE block above because identity_map references
// submissions.submission_token, which has to exist first.
//
// Idempotent: the column and the index are only added if not already present,
// so this is safe on every boot.
//
// Note: SQLite refuses to add a UNIQUE column to a table that already contains
// rows ("Cannot add a UNIQUE column"), so uniqueness is enforced with a
// separate UNIQUE INDEX rather than an inline column constraint. Enforcement is
// equivalent; the column stays nullable so existing rows can be migrated in
// place instead of forcing a risky table rebuild.
const hasSubmissionToken = db
  .prepare('PRAGMA table_info(submissions)')
  .all()
  .some((column) => column.name === 'submission_token');

if (!hasSubmissionToken) {
  db.exec('ALTER TABLE submissions ADD COLUMN submission_token TEXT');
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_submission_token
  ON submissions(submission_token);
`);

// --- Staff accounts -------------------------------------------------------
// Role-based access control, added as nullable columns on `users` rather than a
// new table, so a student identity and a staff identity are the same row and
// there is no second kind of account to keep in sync.
//
// Idempotent, same discipline as the submission_token column above: every
// column is only added if PRAGMA table_info says it is not already there, so
// this is safe on every boot and on a database created before RBAC existed.
//
// All three stay NULLABLE, and that is the load-bearing detail:
//
//   * NULL role means "an ordinary seeded student identity". Those rows behave
//     exactly as they did before this change — they can never authenticate as
//     staff, because authentication requires a non-NULL role, and a submission
//     carrying a student email is unaffected. Adding columns therefore cannot
//     retroactively grant anybody access.
//   * NULL department_id means "not tied to a department" (triage, council and
//     admin, which act across departments).
//
// SQLite permits ADD COLUMN with a CHECK or REFERENCES clause as long as the
// column is nullable, which is exactly the case here. The CHECK is what makes
// `role` a closed vocabulary at the storage layer rather than only in code.
const userColumns = new Set(
  db.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
);

const STAFF_COLUMNS = [
  ['password_hash', 'TEXT'],
  ['role', "TEXT CHECK (role IN ('department_staff','triage','council','admin'))"],
  ['department_id', 'INTEGER REFERENCES departments(department_id)'],
];

for (const [name, definition] of STAFF_COLUMNS) {
  if (!userColumns.has(name)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

// Backfill a token for any row that predates the column, so the "every
// submission has a token" invariant holds. Safe to re-run: it only touches rows
// whose token is still NULL, which new submissions never are.
const rowsWithoutToken = db
  .prepare('SELECT submission_id FROM submissions WHERE submission_token IS NULL')
  .all();

if (rowsWithoutToken.length > 0) {
  const assignToken = db.prepare(
    'UPDATE submissions SET submission_token = ? WHERE submission_id = ?'
  );
  for (const row of rowsWithoutToken) {
    assignToken.run(crypto.randomBytes(16).toString('hex'), row.submission_id);
  }
}

// The only table that maps a submission to a real person. It is deliberately
// never joined in the normal submissions listing or creation path — that
// separation is the entire point, so anonymity must not depend on a query author
// remembering to leave this table out.
db.exec(`
CREATE TABLE IF NOT EXISTS identity_map (
    submission_token TEXT PRIMARY KEY
        REFERENCES submissions(submission_token) ON DELETE CASCADE,
    user_id          INTEGER
        REFERENCES users(user_id) ON DELETE SET NULL,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`);

module.exports = db;
