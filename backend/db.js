const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// Initialize an SQLite database (it will be created automatically in this directory)
const db = new Database(path.join(__dirname, 'gap.db'));

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
