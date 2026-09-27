// Manual seed script for the users table — test / stress-test data only.
//
// Run with:  node seed-users.js
//
// This is deliberately NOT wired into server boot. db.js still only seeds
// departments and categories on startup; requiring './db' here just reuses the
// same connection and guarantees the schema exists.
//
// There is no authentication, login, or password handling in this project yet,
// and none is added here. These rows exist purely so that submissions
// (submitted_by) and status_history entries (changed_by) have a real user id to
// reference once that work is done.
//
// Safe to re-run: emails are unique, so existing rows are ignored rather than
// duplicated.

const db = require('./db');

const USER_COUNT = 50;

function fakeUser(index) {
  return {
    name: `Test Student ${index}`,
    email: `student${index}@test.edu`,
  };
}

const insertUser = db.prepare(
  'INSERT OR IGNORE INTO users (name, email) VALUES (?, ?)'
);

// All-or-nothing, so a failure part-way through leaves no half-seeded table.
const seed = db.transaction(() => {
  let inserted = 0;
  for (let i = 1; i <= USER_COUNT; i++) {
    const { name, email } = fakeUser(i);
    // `changes` is 0 when the UNIQUE(email) constraint causes the row to be
    // skipped, which is how we tell a fresh insert from an existing row.
    if (insertUser.run(name, email).changes > 0) inserted += 1;
  }
  return inserted;
});

const inserted = seed();
const existing = USER_COUNT - inserted;
const { total } = db.prepare('SELECT COUNT(*) AS total FROM users').get();

console.log(`Seeded ${USER_COUNT} test users.`);
console.log(`  inserted:         ${inserted}`);
console.log(`  already existing: ${existing}`);
console.log(`  rows in users:    ${total}`);
console.log('Re-running is safe — existing emails are ignored.');
