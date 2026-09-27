const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

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
app.get('/submissions', (req, res) => {
  try {
    const submissions = db
      .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions ORDER BY created_at DESC`)
      .all();
    res.json(submissions);
  } catch (error) {
    console.error('GET /submissions failed:', error);
    res.status(500).json({ error: 'Could not load submissions.' });
  }
});

// Create a new submission
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
        trimmedTitle,
        trimmedDescription,
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
    res.status(201).json({ id, message: "Submission successful", submission_token: submissionToken });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /submissions failed:', error);
    res.status(500).json({ error: 'Could not create the submission.' });
  }
});

// Advance a submission to the next status in the workflow
app.patch('/submissions/:id/status', (req, res) => {
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

      // changed_by stays NULL because there is no authentication yet.
      db.prepare(`
        INSERT INTO status_history
          (submission_id, old_status, new_status, reason, changed_by)
        VALUES (?, ?, ?, ?, NULL)
      `).run(id, current.status, new_status, trimmedReason);

      return db
        .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_id = ?`)
        .get(id);
    });

    res.json(advance());
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(`PATCH /submissions/${req.params.id}/status failed:`, error);
    res.status(500).json({ error: 'Could not update the submission status.' });
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

    const submission = db
      .prepare(`SELECT ${SUBMISSION_PUBLIC_COLUMNS} FROM submissions WHERE submission_token = ?`)
      .get(token);

    if (!submission) {
      throw notFound;
    }

    // changed_at has one-second resolution, so entries written in the same
    // second would otherwise come back in arbitrary order. history_id is
    // monotonic, which makes the timeline strictly oldest-first.
    const history = db
      .prepare(`
        SELECT old_status, new_status, reason, changed_at
        FROM status_history
        WHERE submission_id = ?
        ORDER BY changed_at ASC, history_id ASC
      `)
      .all(submission.submission_id);

    res.json({ ...submission, history });
  } catch (error) {
    if (error instanceof RequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('GET /submissions/token/:token failed:', error);
    res.status(500).json({ error: 'Could not look up that submission code.' });
  }
});

// TEMPORARY — for local testing of the identity_map linkage only. This has zero
// access control and must be gated behind RBAC before this goes anywhere near a
// real deployment. Do not expose this route publicly.
app.get('/submissions/:id/identity', (req, res) => {
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
