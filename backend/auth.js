// Session-backed role-based access control.
//
// One role per account, stored on the users row (see db.js) and mirrored onto
// the session at login. The session is the source of truth for "who is calling
// this request"; the database is the source of truth for "who they are".
//
// Accepted limitations of the demo phase, called out deliberately rather than
// worked around:
//
//   * The default MemoryStore keeps sessions in this process's heap. Every
//     server restart logs everyone out, and the app cannot be run as more than
//     one process without sessions breaking between them. A real deployment
//     needs a shared store (Redis, or a session table) — that is a config swap
//     here, not a rewrite, because everything below only ever touches
//     req.session.
//   * Role and department are snapshotted into the session at login. If an
//     admin edits someone's role, their existing session keeps the old one
//     until they log in again. Re-reading the users row per request would fix
//     that, at the cost of a database hit on every gated route.

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

// bcrypt cost. 10 is bcrypt's own default and is the usual demo/demo-adjacent
// setting; it is also what create-staff.js hashes with, so the two must stay
// in step (the cost is stored inside the hash, so they cannot drift silently).
const BCRYPT_ROUNDS = 10;

// A real bcrypt hash of a value nobody will ever submit, compared against when
// the email is unknown. Without it, a login attempt for an unregistered address
// would skip the ~100ms bcrypt work and return far faster than one for a
// registered address with a wrong password, which is a timing side channel that
// answers "does this email have an account?" without ever saying so in the
// response body.
const DUMMY_HASH = bcrypt.hashSync('unregistered-address-sentinel', BCRYPT_ROUNDS);

// The closed role vocabulary. Mirrors the CHECK constraint on users.role, so
// the two cannot drift far before the database refuses a write.
const ROLES = {
  DEPARTMENT_STAFF: 'department_staff',
  TRIAGE: 'triage',
  COUNCIL: 'council',
  ADMIN: 'admin',
};

// Who may perform which class of transition. See requireStatusTransition.
const CLOSING_ROLES = [ROLES.COUNCIL, ROLES.ADMIN];
const ADVANCING_ROLES = [ROLES.DEPARTMENT_STAFF, ROLES.ADMIN];

// Triage bounce-back. Two distinct powers, deliberately not overlapping:
//
//   * BOUNCING_ROLES  — return a submission to triage. Only the department
//     currently holding it (or an admin) may do this. Triage is NOT included:
//     triage cannot bounce, because bouncing is the department declining work,
//     and letting triage bounce a submission it is looking at would let it push
//     the queue back onto itself with no departmental judgement ever applied.
//   * REASSIGNING_ROLES — route an unassigned submission to a department. Triage
//     or admin only, with no department scoping: they exist precisely to handle
//     the cross-department queue.
//
// The two roles sets are what make "bounce first, then reassign" a real sequence
// rather than one available shortcut: neither role can do both halves, and
// reassign additionally refuses a submission that already has a department.
const BOUNCING_ROLES = [ROLES.DEPARTMENT_STAFF, ROLES.ADMIN];
const REASSIGNING_ROLES = [ROLES.TRIAGE, ROLES.ADMIN];

function sessionMiddleware() {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    // Not fatal: a hardcoded development fallback keeps `node server.js`
    // working out of the box, which matters for a demo. It is refused when
    // NODE_ENV says this is a real deployment, because a shipped app signing
    // sessions with a constant in the source is not authentication.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set when NODE_ENV=production.');
    }
    console.warn(
      '[auth] SESSION_SECRET is not set — using a development fallback. ' +
        'Sessions will not survive a restart and will not validate across processes. ' +
        'Set SESSION_SECRET before deploying anywhere real.'
    );
  }

  return session({
    name: 'gap.sid',
    secret: secret || 'gap-dev-secret-do-not-use-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      // Not readable from JavaScript, so an XSS bug cannot exfiltrate the
      // session id.
      httpOnly: true,
      // Lax is enough here: the SPA is same-site, and staff navigating in from
      // a link should arrive already logged in.
      sameSite: 'lax',
      // No HTTPS locally, so Secure would silently break every login in
      // development. Set behind TLS in production.
      secure: false,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  });
}

// One generic failure for every way a login can fail: unknown email, no
// password set, wrong password, or a role that is not a staff role. If these
// were distinguishable, the login form would become an oracle for which
// addresses are registered staff.
const INVALID_CREDENTIALS = 'Invalid email or password.';

// Verify a login attempt. Returns { role, departmentId } on success, or null.
//
// password_hash is never returned to the caller and never logged.
function verifyCredentials(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') return null;

  const user = require('./db')
    .prepare('SELECT user_id, password_hash, role, department_id FROM users WHERE email = ?')
    .get(email.trim().toLowerCase());

  if (!user) {
    // Burn the same bcrypt time a real check would take, so an unknown address
    // is not distinguishable from a wrong password by how fast we answer.
    bcrypt.compareSync(password, DUMMY_HASH);
    return null;
  }

  // A seeded student has NULL role and NULL password_hash. They are not staff
  // and cannot log in, but the comparison below still runs so the timing is
  // indistinguishable — the same reason the DUMMY_HASH branch exists.
  const matches = user.password_hash
    ? bcrypt.compareSync(password, user.password_hash)
    : (bcrypt.compareSync(password, DUMMY_HASH), false);

  // A NULL role means an ordinary student identity, which is not a staff
  // account. This is the single point where "has a password" becomes "is
  // staff", so it is checked explicitly rather than inferred from the hash.
  if (!matches || !user.role) return null;

  return {
    userId: user.user_id,
    role: user.role,
    departmentId: user.department_id ?? null,
  };
}

// Marks the session as a staff session. Called only after a successful verify.
function startSession(req, { userId, role, departmentId }) {
  // A fresh session id on privilege change defeats session fixation, so any
  // id an attacker planted before login is discarded here.
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.role = role;
      req.session.departmentId = departmentId;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

function endSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) return resolve();
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

// The public shape of a session, and the only thing /staff/me and /staff/login
// ever send back. password_hash has no field here and never will.
function describeSession(req) {
  if (!req.session || !req.session.userId || !req.session.role) {
    return { role: null, department_id: null };
  }
  return {
    role: req.session.role,
    department_id: req.session.departmentId ?? null,
  };
}

function isAuthenticated(req) {
  return Boolean(req.session && req.session.userId && req.session.role);
}

// General-purpose gate: 401 when there is no staff session, 403 when the
// session exists but holds the wrong role.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Staff sign-in required.' });
    }
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ error: 'Your role cannot do that.' });
    }
    next();
  };
}

// Whether this session may perform a transition to `targetStatus` on a
// submission in `departmentId`.
//
// Split out from the middleware so the same three questions — is anyone signed
// in, does the role cover this class of transition, and does the department
// line up — are answerable in one place, and so the test suite can assert the
// rule without going through HTTP.
//
//   * to "closed"            -> council or admin, any department
//   * any other transition   -> department_staff or admin
//   * department_staff       -> the submission's own department only
//
// The department check returns 403 rather than 404 on purpose: the caller is
// already authenticated and can see the submission in the public listing, so
// there is nothing to conceal by hiding its existence.
function checkTransitionAccess(session, targetStatus, submissionDepartmentId) {
  if (!isAuthenticated({ session })) {
    return { allowed: false, status: 401, error: 'Staff sign-in required.' };
  }

  if (targetStatus === 'closed') {
    if (!CLOSING_ROLES.includes(session.role)) {
      return { allowed: false, status: 403, error: 'Only the council or an admin can close a submission.' };
    }
    return { allowed: true };
  }

  if (!ADVANCING_ROLES.includes(session.role)) {
    return {
      allowed: false,
      status: 403,
      error: 'Only the assigned department staff or an admin can advance this submission.',
    };
  }

  // Admins act across departments, so they are not subject to the match.
  if (session.role === ROLES.ADMIN) return { allowed: true };

  // A department_staff member with no department of their own, or a submission
  // routed to no department, has no legitimate scope here. Null never equals
  // null in this comparison on purpose: two unknowns are not a match.
  if (session.departmentId == null || submissionDepartmentId == null) {
    return { allowed: false, status: 403, error: 'That submission is not in your department.' };
  }
  if (Number(session.departmentId) !== Number(submissionDepartmentId)) {
    return { allowed: false, status: 403, error: 'That submission is not in your department.' };
  }

  return { allowed: true };
}

// Whether this session may return `submissionDepartmentId`'s submission to
// triage. Same shape as checkTransitionAccess so both gates are readable the
// same way, but the rule is the department-scoped one: only the department that
// currently holds the submission may bounce it, and an admin may bounce
// anything.
//
// Returns 403 (not 404) for the same reason as the status gate: an authenticated
// caller can already see the submission in the public listing.
function checkBounceAccess(session, submissionDepartmentId) {
  if (!isAuthenticated({ session })) {
    return { allowed: false, status: 401, error: 'Staff sign-in required.' };
  }

  if (!BOUNCING_ROLES.includes(session.role)) {
    return {
      allowed: false,
      status: 403,
      error: 'Only the assigned department staff or an admin can return a submission to triage.',
    };
  }

  if (session.role === ROLES.ADMIN) return { allowed: true };

  // Null never equals null here either. A department_staff member with no
  // department of their own cannot bounce anything, and a submission routed to
  // no department is triage's to assign, not a department's to bounce.
  if (session.departmentId == null || submissionDepartmentId == null) {
    return { allowed: false, status: 403, error: 'That submission is not in your department.' };
  }
  if (Number(session.departmentId) !== Number(submissionDepartmentId)) {
    return { allowed: false, status: 403, error: 'That submission is not in your department.' };
  }

  return { allowed: true };
}

// Whether this session may route an unassigned submission to a department.
// No department scoping, because triage and admin are the roles that work
// across departments by definition. Whether the submission is actually
// unassigned is a precondition on the write, not part of the permission.
function checkReassignAccess(session) {
  if (!isAuthenticated({ session })) {
    return { allowed: false, status: 401, error: 'Staff sign-in required.' };
  }

  if (!REASSIGNING_ROLES.includes(session.role)) {
    return {
      allowed: false,
      status: 403,
      error: 'Only triage or an admin can assign a submission to a department.',
    };
  }

  return { allowed: true };
}

module.exports = {
  BCRYPT_ROUNDS,
  ROLES,
  sessionMiddleware,
  verifyCredentials,
  startSession,
  endSession,
  describeSession,
  isAuthenticated,
  requireRole,
  checkTransitionAccess,
  checkBounceAccess,
  checkReassignAccess,
  INVALID_CREDENTIALS,
};
