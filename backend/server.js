const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const { presentSubmission, presentSubmissions, presentHistory } = require('./privacy');
const { redactNames, previewRedaction } = require('./redact');

const app = express();

// --- CORS ------------------------------------------------------------------
// The SPA is served from a different origin (Vite on :5173), so staff sessions
// have to cross origins. That requires two things the previous blanket
// app.use(cors()) could not provide:
//
//   * credentials: true, so the browser sends and stores the session cookie, and
//   * an explicit origin list, because the CORS spec forbids pairing a wildcard
//     origin with credentials. A wildcard would mean "any site may make
//     authenticated calls with the user's session", which is precisely the
//     cross-site request forgery this gate is meant to prevent.
//
// The allowlist is the control that makes the session safe; the cookie's
// SameSite is a second, independent layer. Override with CORS_ORIGIN.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // No Origin header: a same-origin request, curl, or a server-to-server
    // call. Nothing cross-origin is happening, so allow it through.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed.`));
  },
  credentials: true,
}));

app.use(express.json());

// Mounted before the routes so every handler can read req.session, and before
// the first staff route so /staff/login has a session to write to.
app.use(auth.sessionMiddleware());

// Authoritative status order. A submission may only move to the immediate
// next entry, so anything else is rejected. Must stay in sync with the CHECK
// constraint on submissions.status in db.js.
const STATUS_SEQUENCE = [
  'submitted',
  'acknowledged',
  'in_progress',
  'pending_council_review',
  'resolved',
  'closed',
];

// Matches the reason column width from the schema doc (VARCHAR(255)).
const MAX_REASON_LENGTH = 255;

function nextStatus(status) {
  const index = STATUS_SEQUENCE.indexOf(status);
  if (index === -1 || index === STATUS_SEQUENCE.length - 1) return null;
  return STATUS_SEQUENCE[index + 1];
}

// Errors we raise deliberately. Carrying the HTTP status lets us throw from
// inside a transaction (which rolls it back) and still respond correctly.
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new RequestError(400, message);

// A random, unguessable handle for a submission. 16 bytes = 128 bits, so the
// token cannot be guessed or enumerated by anyone who has seen another one.
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// The public shape of a submission, enumerated rather than SELECT *.
//
// submission_token is deliberately excluded: it is the only key to the
// identity_map linkage, and these two responses are unauthenticated, so a
// SELECT * here would publish the anonymity key of every submission in the
// system. The token is handed to a submitter once, in the POST response.
//
// Defined once so the listing and the status response cannot drift apart.
const SUBMISSION_PUBLIC_COLUMNS = `
  submission_id, submission_type, title, description, category_id,
  department_id, submitted_by, status, location, is_anonymous,
  created_at, updated_at`;

// Get all submissions
//
// Rows are sorted by the real created_at in SQL and only then passed through
// the display transform, so bucketing an anonymous row's timestamp for display
// cannot reorder the list.
app.get('/submissions', (req, res) => {
  try {
    const submissions = db
      .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions ORDER BY created_at DESC`)
      .all();
    res.json(presentSubmissions(submissions));
  } catch (error) {
    console.error('GET /submissions failed:', error);
    res.status(500).json({ error: 'Could not load submissions.' });
  }
});

// Reference data for the submission form's dropdowns.
//
// Public, like the form itself: a student needs these in order to file a
// grievance and has no account to sign in with, so requiring a session here
// would leave the form unrenderable for exactly the people who need it most.
// What these routes expose is organisational vocabulary — department and
// category names — and not a single row of anyone's grievance, so there is no
// per-submitter data to gate.
//
// Ordered by primary key rather than by name so the list is stable between
// calls and keeps the same order the ids are handed out in. Sorting by name
// would make the dropdown jump around if a department were ever renamed.
app.get('/departments', (req, res) => {
  try {
    const departments = db
      .prepare(`
        SELECT department_id, name, description
        FROM departments
        ORDER BY department_id
      `)
      .all();
    res.json(departments);
  } catch (error) {
    console.error('GET /departments failed:', error);
    res.status(500).json({ error: 'Could not load departments.' });
  }
});

// The categories a submitter can pick from, with the submission_type they apply
// to. Public for the same reason as /departments, and the client filters by
// submission_type rather than the server, so that switching the type on the
// form needs no second request.
app.get('/categories', (req, res) => {
  try {
    const categories = db
      .prepare(`
        SELECT category_id, name, submission_type, department_id
        FROM categories
        ORDER BY category_id
      `)
      .all();
    res.json(categories);
  } catch (error) {
    console.error('GET /categories failed:', error);
    res.status(500).json({ error: 'Could not load categories.' });
  }
});

// Show a submitter what name redaction will do to their text before anything is
// stored. Preview only: this reads no rows and writes none, so it can be called
// as often as the user likes while they edit.
app.post('/submissions/redact-preview', (req, res) => {
  const { title, description } = req.body ?? {};

  try {
    if (title !== undefined && typeof title !== 'string') {
      throw badRequest('title must be a string.');
    }
    if (description !== undefined && typeof description !== 'string') {
      throw badRequest('description must be a string.');
    }

    // Only the masked text and a count come back. The detected names themselves
    // are the sensitive payload and are deliberately not echoed.
    res.json(previewRedaction(title ?? '', description ?? ''));
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /submissions/redact-preview failed:', error);
    res.status(500).json({ error: 'Could not check the text for names.' });
  }
});

// Create a new submission
//
// Name redaction runs here unconditionally; see below. This route is the only
// writer of submissions rows.
app.post('/submissions', (req, res) => {
  const { submission_type, title, description, category_id, department_id, location, is_anonymous, user_email } = req.body ?? {};

  try {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';

    if (submission_type !== 'request' && submission_type !== 'complaint') {
      throw badRequest('submission_type must be either "request" or "complaint".');
    }
    if (!trimmedTitle) {
      throw badRequest('title is required.');
    }
    if (!trimmedDescription) {
      throw badRequest('description is required.');
    }

    // Name and email-address redaction run here, unconditionally, and their
    // results are what gets written. It is deliberately not gated on anything
    // the client said: the preview is a courtesy to the submitter, but a
    // client-side check is not a safety net, so the server re-checks the text it
    // was actually handed. A client that skipped the preview, ignored it, or
    // raced it is irrelevant. `masked` covers names and email addresses, so
    // neither can be silently altered. The match lists are used only to set the
    // flag below — never stored, never logged, never returned.
    const titleResult = redactNames(trimmedTitle);
    const descriptionResult = redactNames(trimmedDescription);
    const redacted = titleResult.masked || descriptionResult.masked;

    // A token is generated for every submission, anonymous or not. It is the
    // only link between a submission and the identity_map row that may hold a
    // real person, so it must be unguessable and must always exist.
    const submissionToken = generateToken();

    // submitted_by is intentionally never written. Identity belongs in
    // identity_map, keyed by the token, not on the submission record itself.
    const insert = db.prepare(`
      INSERT INTO submissions 
      (submission_type, title, description, category_id, department_id, location, is_anonymous, submission_token) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Convert boolean to integer for SQLite
    const anonymousFlag = is_anonymous ? 1 : 0;

    const findUserByEmail = db.prepare('SELECT user_id FROM users WHERE email = ?');

    // The submission row, its opening history row and any identity_map row must
    // all land, or none of them do.
    const create = db.transaction(() => {
      const info = insert.run(
        submission_type,
        titleResult.redactedText,
        descriptionResult.redactedText,
        category_id || null,
        department_id || null,
        location || null,
        anonymousFlag,
        submissionToken
      );

      // Log the initial status in history
      db.prepare(`
        INSERT INTO status_history (submission_id, new_status, reason)
        VALUES (?, 'submitted', 'Initial submission via API')
      `).run(info.lastInsertRowid);

      // Optional identity capture, written here and nowhere else. No row in
      // identity_map means no identity was ever captured for this submission —
      // the strongest anonymity case, and what every anonymous submission gets.
      //
      // A user_email that matches no seeded user is ignored rather than
      // rejected: this is a testing-phase convenience, not authentication, so a
      // bad address must never be able to block a submission.
      if (typeof user_email === 'string' && user_email.trim() !== '') {
        const user = findUserByEmail.get(user_email.trim());
        if (user) {
          db.prepare(`
            INSERT INTO identity_map (submission_token, user_id)
            VALUES (?, ?)
          `).run(submissionToken, user.user_id);
        }
      }

      return info.lastInsertRowid;
    });

    const id = create();

    // The token is released exactly once, here, to the submitter who just
    // created the submission. It is their handle for tracking their own
    // submission without an account, which is why it is not also published by
    // the listing or the status response.
    //
    // `redacted` tells the submitter the server changed their words on the way
    // in. They are told what was stored, so it can never be a silent edit.
    res.status(201).json({
      id,
      message: "Submission successful",
      submission_token: submissionToken,
      redacted,
    });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /submissions failed:', error);
    res.status(500).json({ error: 'Could not create the submission.' });
  }
});

// --- Staff authentication -------------------------------------------------
//
// Deliberately not linked from the Submit/Browse/Track navigation: a student
// should never be nudged to log in, and the only reason to hold a staff session
// is to triage someone else's complaint.

// Staff sign-in.
//
// One generic 401 covers every failure mode — unknown email, no password set,
// wrong password, and a seeded student who is not staff. Distinguishing them
// would turn this form into a lookup table of registered staff addresses.
app.post('/staff/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  try {
    const account = auth.verifyCredentials(email, password);

    if (!account) {
      return res.status(401).json({ error: auth.INVALID_CREDENTIALS });
    }

    await auth.startSession(req, account);

    // describeSession, not the raw account, so password_hash has no path to a
    // response even if a future field is added to the account object.
    res.json(auth.describeSession(req));
  } catch (error) {
    console.error('POST /staff/login failed:', error);
    res.status(500).json({ error: 'Could not sign in right now.' });
  }
});

app.post('/staff/logout', async (req, res) => {
  try {
    await auth.endSession(req);
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /staff/logout failed:', error);
    res.status(500).json({ error: 'Could not sign out right now.' });
  }
});

// What the current session can do. This is the endpoint the Browse view uses to
// decide which action buttons to show, so a signed-out visitor gets
// { role: null } and is shown nothing rather than a button that would 401.
app.get('/staff/me', (req, res) => {
  res.json(auth.describeSession(req));
});

// Gate for the status transition route.
//
// Runs before the handler, so an unauthenticated caller is answered 401
// without ever learning whether their body was well-formed — validation
// messages are a small but free source of information, and authentication is
// supposed to come first.
//
// The role class is decided from the requested target status alone; the
// department match additionally needs the submission's own department_id, so
// that one row is read here. The handler re-reads the row inside its
// transaction, which stays the authoritative copy — this read exists only to
// answer the gate, and nothing is trusted from it afterwards.
//
// Malformed ids and missing submissions are passed through untouched: they are
// the handler's 400 and 404, and deciding them here would either leak existence
// or duplicate logic.
function requireTransitionAccess(req, res, next) {
  if (!auth.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Staff sign-in required.' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  const targetStatus =
    typeof req.body?.new_status === 'string' ? req.body.new_status.trim() : null;

  const row = db
    .prepare('SELECT department_id FROM submissions WHERE submission_id = ?')
    .get(id);

  if (!row) return next();

  const verdict = auth.checkTransitionAccess(req.session, targetStatus, row.department_id);
  if (!verdict.allowed) {
    return res.status(verdict.status).json({ error: verdict.error });
  }

  next();
}

// Advance a submission to the next status in the workflow
app.patch('/submissions/:id/status', requireTransitionAccess, (req, res) => {
  const { new_status, reason } = req.body ?? {};
  const id = Number(req.params.id);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  try {
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Submission id must be a positive integer.');
    }
    if (typeof new_status !== 'string' || new_status.trim() === '') {
      throw badRequest('new_status is required.');
    }
    if (!STATUS_SEQUENCE.includes(new_status)) {
      throw badRequest(
        `Unknown status "${new_status}". Valid statuses are: ${STATUS_SEQUENCE.join(', ')}.`
      );
    }
    if (!trimmedReason) {
      throw badRequest('A reason is required to change a submission status.');
    }
    if (trimmedReason.length > MAX_REASON_LENGTH) {
      throw badRequest(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }

    // Read, validate, update and log as one unit: either the status change and
    // its history row both persist, or neither does.
    const advance = db.transaction(() => {
      const current = db
        .prepare('SELECT submission_id, status FROM submissions WHERE submission_id = ?')
        .get(id);

      if (!current) {
        throw new RequestError(404, `No submission found with id ${id}.`);
      }

      const expected = nextStatus(current.status);

      if (new_status !== expected) {
        if (expected === null) {
          throw badRequest(
            `Submission ${id} is already at the final status "${current.status}" and cannot change.`
          );
        }
        if (new_status === current.status) {
          throw badRequest(`Submission ${id} is already "${current.status}".`);
        }
        throw badRequest(
          `Cannot change submission ${id} from "${current.status}" to "${new_status}". ` +
            `The only allowed next status is "${expected}".`
        );
      }

      // SQLite does not maintain updated_at on its own, so set it explicitly.
      db.prepare(`
        UPDATE submissions
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE submission_id = ?
      `).run(new_status, id);

      // changed_by is the staff account the gate already proved is authorised:
      // requireTransitionAccess runs before this handler, so by the time we get
      // here req.session.userId is a real, role-checked account. It is still not
      // exposed by any response — the history projection selects only
      // old_status/new_status/reason/changed_at — so this is an audit trail on
      // disk, not a new privacy surface.
      db.prepare(`
        INSERT INTO status_history
          (submission_id, old_status, new_status, reason, changed_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, current.status, new_status, trimmedReason, req.session.userId);

      return db
        .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_id = ?`)
        .get(id);
    });

    // An anonymous submitter gets bucketed display timestamps here too — the
    // moment a status moved is just as identifying as the moment it was filed.
    res.json(presentSubmission(advance()));
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`PATCH /submissions/${req.params.id}/status failed:`, error);
    res.status(500).json({ error: 'Could not update the submission status.' });
  }
});

// --- Triage bounce-back -----------------------------------------------------
//
// Two halves of one workflow, with no single role able to perform both:
//
//   department bounces (submission -> unassigned) -> triage/admin reassigns
//
// Splitting it that way is the whole point. A department declining work is a
// departmental judgement, and routing the work is a triage judgement, so neither
// is left to the other. The gates below encode that; see BOUNCING_ROLES and
// REASSIGNING_ROLES in auth.js.
//
// Mirrors requireTransitionAccess: the gate reads the row to answer the
// permission question, and the handler re-reads it inside its own transaction
// and trusts only that copy.

function requireBounceAccess(req, res, next) {
  if (!auth.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Staff sign-in required.' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  const row = db
    .prepare('SELECT department_id FROM submissions WHERE submission_id = ?')
    .get(id);

  if (!row) return next();

  const verdict = auth.checkBounceAccess(req.session, row.department_id);
  if (!verdict.allowed) {
    return res.status(verdict.status).json({ error: verdict.error });
  }

  next();
}

function requireReassignAccess(req, res, next) {
  const verdict = auth.checkReassignAccess(req.session);
  if (!verdict.allowed) {
    return res.status(verdict.status).json({ error: verdict.error });
  }
  next();
}

// Return a submission to triage.
//
// The department is cleared rather than set to some "triage" sentinel, because
// NULL is already the "nobody owns this" state the rest of the app understands —
// triage's queue is exactly "department_id IS NULL", and no department is a real
// id the way a routing table entry is.
app.post('/submissions/:id/bounce', requireBounceAccess, (req, res) => {
  const { reason } = req.body ?? {};
  const id = Number(req.params.id);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  try {
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Submission id must be a positive integer.');
    }
    // Same reason contract as a status change: something has to be on the record
    // saying why this left the department.
    if (!trimmedReason) {
      throw badRequest('A reason is required to return a submission to triage.');
    }
    if (trimmedReason.length > MAX_REASON_LENGTH) {
      throw badRequest(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }

    const bounce = db.transaction(() => {
      const current = db
        .prepare('SELECT submission_id, department_id FROM submissions WHERE submission_id = ?')
        .get(id);

      if (!current) {
        throw new RequestError(404, `No submission found with id ${id}.`);
      }

      // Re-check the permission inside the transaction, not just at the gate.
      // Here the row's own department_id *is* the authorisation input, so a
      // read taken before the transaction could be stale by the time it is
      // acted on. The status route gets away without this because its gate
      // depends only on the session; this one would not.
      const verdict = auth.checkBounceAccess(req.session, current.department_id);
      if (!verdict.allowed) {
        throw new RequestError(verdict.status, verdict.error);
      }

      // "Nothing to bounce from" is a client-side mistake, not a permission
      // problem, so it is a 400 and not a 403.
      if (current.department_id == null) {
        throw badRequest(
          `Submission ${id} is not assigned to a department, so there is nothing to return to triage.`
        );
      }

      db.prepare(`
        UPDATE submissions
        SET department_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE submission_id = ?
      `).run(id);

      db.prepare(`
        INSERT INTO reassignment_history
          (submission_id, old_department_id, new_department_id, reason, changed_by)
        VALUES (?, ?, NULL, ?, ?)
      `).run(id, current.department_id, trimmedReason, req.session.userId);

      return db
        .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_id = ?`)
        .get(id);
    });

    // Bucketed like every other timestamp, for the same reason: when a
    // submission was bounced is as identifying as when it was filed.
    res.json(presentSubmission(bounce()));
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`POST /submissions/${req.params.id}/bounce failed:`, error);
    res.status(500).json({ error: 'Could not return the submission to triage.' });
  }
});

// Route an unassigned submission to a department.
app.post('/submissions/:id/reassign', requireReassignAccess, (req, res) => {
  const { department_id, reason } = req.body ?? {};
  const id = Number(req.params.id);
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

  try {
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Submission id must be a positive integer.');
    }
    if (!trimmedReason) {
      throw badRequest('A reason is required to assign a submission to a department.');
    }
    if (trimmedReason.length > MAX_REASON_LENGTH) {
      throw badRequest(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
    }

    // department_id must name a row that exists. A select cannot be assigned to
    // a department id the routing table has never heard of, and letting an
    // unknown id through would fail later as a foreign-key error with a much
    // less useful message.
    if (department_id === undefined || department_id === null || department_id === '') {
      throw badRequest('department_id is required.');
    }
    const targetDepartmentId = Number(department_id);
    if (!Number.isInteger(targetDepartmentId) || targetDepartmentId <= 0) {
      throw badRequest('department_id must be a positive integer.');
    }
    if (!db.prepare('SELECT department_id FROM departments WHERE department_id = ?').get(targetDepartmentId)) {
      throw badRequest(`No department found with id ${targetDepartmentId}.`);
    }

    const reassign = db.transaction(() => {
      const current = db
        .prepare('SELECT submission_id, department_id FROM submissions WHERE submission_id = ?')
        .get(id);

      if (!current) {
        throw new RequestError(404, `No submission found with id ${id}.`);
      }

      // Refuse to move an already-routed submission. Letting triage silently
      // reassign work that a department is holding would short-circuit the
      // bounce handshake and make the reassignment trail lie: the row would
      // claim an old_department_id of NULL for a submission that was never
      // unassigned. If triage really needs to move assigned work, that is a
      // separate, explicitly-scoped feature rather than an implied one.
      if (current.department_id != null) {
        throw badRequest(
          `Submission ${id} is already assigned to a department. It has to be returned to triage first.`
        );
      }

      db.prepare(`
        UPDATE submissions
        SET department_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE submission_id = ?
      `).run(targetDepartmentId, id);

      db.prepare(`
        INSERT INTO reassignment_history
          (submission_id, old_department_id, new_department_id, reason, changed_by)
        VALUES (?, NULL, ?, ?, ?)
      `).run(id, targetDepartmentId, trimmedReason, req.session.userId);

      return db
        .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_id = ?`)
        .get(id);
    });

    res.json(presentSubmission(reassign()));
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`POST /submissions/${req.params.id}/reassign failed:`, error);
    res.status(500).json({ error: 'Could not assign the submission to a department.' });
  }
});

// Look up one submission by the token issued at creation time — the accountless
// way for a submitter to follow their own grievance to resolution.
//
// This is the only route that resolves a token, and it is deliberately
// single-row:
//
//   * The lookup is an equality comparison on the token column, so it rides the
//     unique index idx_submissions_submission_token. There is no LIKE, no
//     prefix match, no optional filter and no "list by token" variant, so the
//     endpoint cannot be walked one submission at a time.
//   * A token is 16 random bytes (128 bits), so guessing one is not feasible and
//     no rate limiting is applied here. The token is the credential, so if one
//     ever leaks — a screenshot, a shared link, browser history — the fix is to
//     invalidate that token, not to slow this route down.
//
// Malformed input and a real miss are answered identically, with the same 404
// and the same message, so the route cannot be used to test whether some other
// token exists: a short string, a non-hex string, an uppercased token and a
// perfectly well-formed token that simply is not in the database are all
// indistinguishable from the outside.
//
// One pre-existing app-wide caveat: Express percent-decodes the path before any
// handler runs, so a request whose *URL* carries a broken escape (%zz) fails
// with a URIError and is answered 500 by the terminal handler below, exactly as
// /submissions/:id/identity already does. That distinguishes a malformed URL
// from a missing token, but it says nothing about whether any token exists, and
// the browser UI cannot trigger it because api.js encodeURIComponent-escapes the
// code before sending. Fixing it means touching the shared terminal handler,
// which is out of scope here.
//
// The literal "token" path segment means this route can never be shadowed by
// /submissions/:id/identity below, and neither shadows the other.
app.get('/submissions/token/:token', (req, res) => {
  const token = req.params.token;
  const notFound = new RequestError(404, 'No submission found for that code.');

  try {
    // Tokens are always 32 lowercase hex characters. Checking the shape keeps
    // the query below a pure equality lookup on a known-good value.
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
      throw notFound;
    }

    const row = db
      .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_token = ?`)
      .get(token);

    if (!row) {
      throw notFound;
    }

    const submission = presentSubmission(row);
    const submissionId = submission.submission_id;

    // Two histories, merged into one timeline.
    //
    // Each table is ordered by (changed_at, history_id) in its own SQL, exactly
    // as before. history_id is monotonic *within a table*, which is all it was
    // ever relied on for: it breaks ties between rows written in the same
    // second, and both tables have second-resolution CURRENT_TIMESTAMP.
    //
    // Across the two tables the existing tiebreaker does not carry over, and the
    // choice here is deliberate rather than an oversight. Each table numbers
    // from 1 independently, so a status row with history_id 5 and a
    // reassignment row with history_id 2 carry no relative ordering at all --
    // comparing them would be comparing unrelated counters and would silently
    // invent an order. The two writes are also separate transactions, so when
    // they land in the same second the true order is not recoverable from the
    // data at all: nothing recorded it.
    //
    // So the merge sorts on changed_at alone and leans on Array#sort being
    // stable (guaranteed since ES2019): the concatenated array puts status
    // entries first, so same-second ties come back status-before-reassignment,
    // deterministically, while each table's own history_id order is preserved
    // untouched. The guarantee that matters is not "the true order" but "the
    // same order every time" -- an unstable or arbitrary order would make the
    // timeline flicker between two calls for the same data.
    //
    // Sorting happens on the *raw* timestamps, before anonymity bucketing below,
    // for the same reason the status query sorts in SQL: bucketing first would
    // collapse a run of distinct seconds onto one hour label and destroy the
    // ordering it is supposed to be reporting.
    const statusEntries = db
      .prepare(`
        SELECT old_status, new_status, reason, changed_at
        FROM status_history
        WHERE submission_id = ?
        ORDER BY changed_at ASC, history_id ASC
      `)
      .all(submissionId)
      .map((entry) => ({ ...entry, type: 'status' }));

    // Department ids are resolved to names here rather than in the client, and
    // NULL is rendered as "Unassigned" rather than sent as a null the UI would
    // have to recognise. The token holder is a student following their own
    // grievance and has no business reading numeric routing ids, and a
    // department that was later deleted would otherwise show as a bare number
    // that means nothing.
    const reassignmentEntries = db
      .prepare(`
        SELECT
          r.old_department_id,
          r.new_department_id,
          r.reason,
          r.changed_at,
          old_department.name AS old_department_name,
          new_department.name AS new_department_name
        FROM reassignment_history AS r
        LEFT JOIN departments AS old_department
          ON old_department.department_id = r.old_department_id
        LEFT JOIN departments AS new_department
          ON new_department.department_id = r.new_department_id
        WHERE r.submission_id = ?
        ORDER BY r.changed_at ASC, r.history_id ASC
      `)
      .all(submissionId)
      .map((entry) => ({
        type: 'reassignment',
        reason: entry.reason,
        changed_at: entry.changed_at,
        old_department:
          entry.old_department_id == null ? 'Unassigned' : entry.old_department_name ?? 'Unassigned',
        new_department:
          entry.new_department_id == null ? 'Unassigned' : entry.new_department_name ?? 'Unassigned',
      }));

    const history = [...statusEntries, ...reassignmentEntries].sort((a, b) =>
      a.changed_at < b.changed_at ? -1 : a.changed_at > b.changed_at ? 1 : 0
    );

    // A history row inherits the parent submission's anonymity, so an anonymous
    // submission's timeline is bucketed to the hour as well.
    res.json({ ...submission, history: presentHistory(history, submission.is_anonymous) });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('GET /submissions/token/:token failed:', error);
    res.status(500).json({ error: 'Could not look up that submission code.' });
  }
});

// Reveals the real person behind a submission. This is the most sensitive route
// in the app: it walks identity_map and prints a name and an email address, so
// it resolves an anonymous complaint to a human being.
//
// It used to carry no access control at all and a comment saying so. That is
// now closed: requireRole('admin') makes an unauthenticated call 401 and any
// non-admin staff role 403, checked before the id is even validated so an
// outsider cannot map which ids exist.
//
// Admin-only rather than any staff, because the whole point of the identity
// layer is that staff reading complaints do not learn who filed them. A
// department staff member who could call this could re-identify every anonymous
// grievance in their department, which defeats the anonymity guarantee the rest
// of the codebase is built to preserve.
app.get('/submissions/:id/identity', auth.requireRole(auth.ROLES.ADMIN), (req, res) => {
  const id = Number(req.params.id);

  try {
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Submission id must be a positive integer.');
    }

    const row = db
      .prepare('SELECT submission_token FROM submissions WHERE submission_id = ?')
      .get(id);

    if (!row) {
      throw new RequestError(404, `No submission found with id ${id}.`);
    }

    if (!row.submission_token) {
      return res.json({ identified: false });
    }

    const match = db
      .prepare(`
        SELECT u.email, u.name
        FROM identity_map m
        JOIN users u ON u.user_id = m.user_id
        WHERE m.submission_token = ?
      `)
      .get(row.submission_token);

    if (!match) {
      return res.json({ identified: false });
    }

    res.json({ identified: true, email: match.email, name: match.name });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`GET /submissions/${req.params.id}/identity failed:`, error);
    res.status(500).json({ error: 'Could not look up the submission identity.' });
  }
});

// Terminal error handler: keeps every response JSON, including for a malformed
// request body, and never exposes internal error details to the client.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof RequestError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start the server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
