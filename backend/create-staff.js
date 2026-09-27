// Manual seed script for demo staff accounts — local testing only.
//
// Run with:  node create-staff.js
//
// Deliberately NOT wired into server boot, same as seed-users.js: these are
// demo fixtures with published passwords, and a real deployment must never
// create them by accident on startup.
//
// Safe to re-run: emails are unique and the insert is INSERT OR IGNORE, so a
// second run reports the accounts as already existing rather than duplicating
// or resetting them. Re-running therefore does NOT rotate a password you have
// changed since the last run.
//
// Requires bcrypt to hash with, and requires the users table to already have
// the password_hash / role / department_id columns — which db.js adds
// idempotently on boot, and requiring './db' below guarantees.

const bcrypt = require('bcrypt');
const db = require('./db');
const { BCRYPT_ROUNDS } = require('./auth');

// The role vocabulary, matching the CHECK constraint on users.role.
const DEPARTMENT_STAFF = 'department_staff';
const TRIAGE = 'triage';
const COUNCIL = 'council';
const ADMIN = 'admin';

// Department is resolved by name rather than by a hardcoded id, so re-running
// against a database whose departments were seeded in a different order still
// binds the account to Hostel Maintenance. A name that is not present is an
// error rather than a silently NULL department, because a department_staff
// account with no department of its own can never advance anything and would
// fail every check in a confusing way.
function departmentIdByName(name) {
  const row = db
    .prepare('SELECT department_id FROM departments WHERE name = ?')
    .get(name);
  if (!row) {
    throw new Error(`Cannot seed staff: department "${name}" does not exist.`);
  }
  return row.department_id;
}

// One account per role, so every branch of the access rules in auth.js has a
// real login to test against. These are fixed demo credentials on purpose —
// they are printed to the console below, and the whole point is that a reviewer
// can log in without asking anyone for anything.
const STAFF = [
  {
    name: 'Hostel Maintenance Staff',
    email: 'staff.hostel@uni.edu',
    role: DEPARTMENT_STAFF,
    department: 'Hostel Maintenance',
    password: 'hostel-staff-demo',
  },
  {
    name: 'Triage Officer',
    email: 'triage@uni.edu',
    role: TRIAGE,
    department: null,
    password: 'triage-demo',
  },
  {
    name: 'Council Member',
    email: 'council@uni.edu',
    role: COUNCIL,
    department: null,
    password: 'council-demo',
  },
  {
    name: 'Administrator',
    email: 'admin@uni.edu',
    role: ADMIN,
    department: null,
    password: 'admin-demo',
  },
];

// Emails are stored lower-cased so login can match them the same way. The
// column has always been free-text, so existing seeded rows may not be.
const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (name, email, password_hash, role, department_id)
  VALUES (?, ?, ?, ?, ?)
`);

const results = [];

const seed = db.transaction(() => {
  for (const person of STAFF) {
    const email = person.email.toLowerCase();
    const departmentId = person.department
      ? departmentIdByName(person.department)
      : null;

    // Hashed even when the row already exists, so the cost of the run does not
    // depend on whether this is a first or subsequent run.
    const passwordHash = bcrypt.hashSync(person.password, BCRYPT_ROUNDS);

    const info = insertUser.run(
      person.name,
      email,
      passwordHash,
      person.role,
      departmentId
    );

    results.push({
      ...person,
      email,
      departmentId,
      inserted: info.changes > 0,
    });
  }
});

seed();

const { total } = db.prepare('SELECT COUNT(*) AS total FROM users').get();
const inserted = results.filter((r) => r.inserted).length;

const line = '─'.repeat(72);

console.log(`\n${line}`);
console.log('  Demo staff accounts');
console.log(line);

for (const r of results) {
  console.log(`\n  ${r.role}`);
  console.log(`    email:       ${r.email}`);
  console.log(`    password:    ${r.password}`);
  console.log(`    department:  ${r.department ?? '(none — acts across departments)'}`);
  console.log(`    status:      ${r.inserted ? 'created' : 'already existed, left unchanged'}`);
}

console.log(`\n${line}`);
console.log(`  created:            ${inserted}`);
console.log(`  already existing:   ${results.length - inserted}`);
console.log(`  rows in users:      ${total}`);
console.log('\n  These passwords are printed on purpose and are demo-only.');
console.log('  Do not reuse them anywhere, and do not run this against a real deployment.');
console.log('\n  Sign in at  http://localhost:5173/staff/login');
console.log(`  The sign-in link is intentionally absent from the app navigation.`);
console.log(`${line}\n`);
