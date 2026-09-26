const Database = require('better-sqlite3');
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

module.exports = db;
