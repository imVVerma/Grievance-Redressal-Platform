// Test harness: assertions, HTTP helpers, and fixture builders shared by every
// suite in tests/.
//
// Intended shape for a new test file:
//
//   import { suite, ctx } from './lib/harness.mjs';
//   export default async function run(t) {
//     t.section('something');
//     t.ok('a thing is true', someCondition, 'detail shown only on failure');
//   }
//
// The runner in run.mjs supplies `t` with the base URL already pointed at the
// throwaway test server, so a suite never hardcodes a port or a path.

import { createRequire } from 'node:module';

let shared = null;

/** Populated by run.mjs before any suite executes. */
export function setContext(next) {
  shared = next;
}

export function ctx() {
  if (!shared) throw new Error('harness: setContext() was not called (is run.mjs the entry point?)');
  return shared;
}

export class Suite {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failures = [];
    this._section = null;
  }

  section(title) {
    this._section = title;
    console.log(`\n--- ${title} ---`);
  }

  /**
   * Record one assertion. `detail` is only printed when the check fails, so
   * passing output stays readable and failures stay diagnosable.
   */
  ok(label, condition, detail = '') {
    if (condition) {
      this.passed++;
      return true;
    }
    this.failures.push({ section: this._section, label, detail: String(detail ?? '') });
    return false;
  }

  /**
   * Assert that `fn` throws. Used for the cases where "the server did not crash"
   * is the thing under test, e.g. a malformed request body.
   */
  async throws(label, fn, detail = '') {
    try {
      await fn();
      return this.ok(label, false, `expected a throw, got none ${detail}`);
    } catch {
      return this.ok(label, true);
    }
  }

  /** Print a summary for this suite. Returns the number of failures. */
  report() {
    const failed = this.failures.length;
    console.log(`\n${this.name}: ${this.passed} passed, ${failed} failed`);
    if (failed) {
      console.log('  failures:');
      for (const f of this.failures) {
        const where = f.section ? ` [${f.section}]` : '';
        console.log(`   - ${f.label}${where}${f.detail ? ` -> ${f.detail}` : ''}`);
      }
    }
    return failed;
  }
}

export const suite = (name) => new Suite(name);

// --- HTTP ------------------------------------------------------------------

/** Parse a response body as JSON, tolerating an empty or non-JSON body. */
export async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Issue a request against the test server. `jar` is an opaque session cookie
 * string; pass it to act as a signed-in staff member.
 */
export async function call(method, path, body, jar) {
  const init = {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(jar ? { Cookie: jar } : {}),
      ...call.extraHeaders,
    },
  };
  // The body key is added only when there is a body. A `body: undefined` on a GET
  // is legal in undici today, but it is exactly the kind of thing a future fetch
  // implementation rejects, and it hides which requests are meant to have bodies.
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(ctx().base + path, init);
  return { status: res.status, data: await json(res), headers: res.headers };
}

/** Merge extra headers into every subsequent call (used for CORS Origin tests). */
export function withHeaders(headers) {
  call.extraHeaders = headers;
  return () => {
    call.extraHeaders = undefined;
  };
}

export const get = (path, jar) => call('GET', path, undefined, jar);
export const post = (path, body, jar) => call('POST', path, body, jar);
export const patch = (path, body, jar) => call('PATCH', path, body, jar);

/** Sign in and return the session cookie jar. Throws if sign-in fails. */
export async function login(email, password) {
  const res = await post('/staff/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`harness: login failed for ${email}: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return cookieFrom(res.headers);
}

/** Extract the session cookie from a Set-Cookie header list. */
export function cookieFrom(headers) {
  return (headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

// --- Fixtures --------------------------------------------------------------

/** Unique-ish suffix so rows created by a run are easy to tell apart later. */
let counter = 0;
export const uniqueTitle = (prefix = 'fixture') => `${prefix}-${process.pid}-${counter++}`;

/** Create a submission and return the created row. */
export async function createSubmission(overrides = {}) {
  const res = await post('/submissions', {
    submission_type: 'request',
    title: uniqueTitle('test'),
    description: 'created by the test suite',
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`harness: create failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  // The create route returns { id, message, submission_token, redacted } — not the
  // full row. Re-read through the public listing to get the stored values.
  const row = await rowById(res.data.id);
  if (!row) throw new Error(`harness: created submission ${res.data.id} is not in the listing`);
  return { ...row, submission_token: res.data.submission_token, redacted: res.data.redacted };
}

/**
 * Read one submission. There is no GET /submissions/:id — the SPA catch-all
 * answers that path with HTML — so this filters the public listing.
 */
export async function rowById(id) {
  const res = await get('/submissions');
  if (res.status !== 200 || !Array.isArray(res.data)) return null;
  return res.data.find((r) => r.submission_id === id) ?? null;
}

/** Sign in as a seeded staff member by role. */
export const STAFF = {
  dept: { email: 'staff.hostel@uni.edu', password: 'hostel-staff-demo', role: 'department_staff', department_id: 1 },
  triage: { email: 'triage@uni.edu', password: 'triage-demo', role: 'triage', department_id: null },
  council: { email: 'council@uni.edu', password: 'council-demo', role: 'council', department_id: null },
  admin: { email: 'admin@uni.edu', password: 'admin-demo', role: 'admin', department_id: null },
};

/** All four seeded roles, signed in. Keyed by the short role name. */
export async function allJars() {
  const jars = {};
  for (const [key, creds] of Object.entries(STAFF)) {
    jars[key] = await login(creds.email, creds.password);
  }
  return jars;
}

// --- Direct database access ------------------------------------------------
//
// Read-only by default so a test cannot quietly mutate the fixture database
// behind the server's back. The few places that need a direct write (forcing a
// same-second timestamp collision, exercising ON DELETE CASCADE) ask for a
// writable handle explicitly.

export const require = createRequire(import.meta.url);
export const Database = (p) => new (require('better-sqlite3'))(p);

/** Read-only handle on the test database. */
export function readDb() {
  return Database(ctx().dbPath);
}

/** A short-lived writable handle. Caller must close it. */
export function writeDb() {
  return new (require('better-sqlite3'))(ctx().dbPath);
}
